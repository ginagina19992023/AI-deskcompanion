#!/usr/bin/env python3
"""
Voice conversion: re-voice an isolated vocal track with an RVC model,
keeping the original melody/rhythm/timing intact (only the timbre changes).
Uses hf-rvc (github.com/esnya/hf-rvc) for the actual RVC model inference,
which is fairseq-free at *inference* time -- but converting a raw
community .pth (the one-time step below) still calls into fairseq's own
checkpoint_utils to read hubert_base.pt, so fairseq is still a real
dependency here, just not one hf-rvc's own inference path needs.

Usage: python voice-convert.py <input_audio> <model_pth_path> <output_path> [index_path] [pitch_shift] [index_rate]
Output: JSON with the path to the converted audio, or an error.

Deliberately generic on the model -- this script doesn't know or care which
RVC model it's pointed at (community-downloaded or self-trained later).
Point it at any community <model>.pth and it converts + caches it into
hf-rvc's format on first use, then runs the same way every time after, so
swapping voices is just swapping the file path, not touching this script.
"""

import json
import sys
import hashlib
import urllib.request
from pathlib import Path

try:
    import torch
    import soundfile as sf
    from hf_rvc import RVCFeatureExtractor, RVCModel
except ImportError as e:
    print(json.dumps({"error": f"hf-rvc not installed correctly: {e}. Run: pip install git+https://github.com/esnya/hf-rvc.git"}), file=sys.stderr)
    sys.exit(1)

# The generic content-encoder checkpoint every RVC model (community or
# self-trained) is built on top of -- not a specific voice, just the shared
# starting point the whole RVC ecosystem uses. Cached locally once, reused
# for every model conversion after that.
HUBERT_BASE_URL = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/hubert_base.pt"
HUBERT_CACHE_DIR = Path.home() / ".cache" / "rvc-models"
HUBERT_BASE_PATH = HUBERT_CACHE_DIR / "hubert_base.pt"


def ensure_hubert_base() -> Path:
    HUBERT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not HUBERT_BASE_PATH.exists():
        urllib.request.urlretrieve(HUBERT_BASE_URL, str(HUBERT_BASE_PATH))
    return HUBERT_BASE_PATH


def converted_model_dir(model_path: str) -> Path:
    # Cache key is the source file's content hash, not its name/path -- two
    # differently-named copies of the same model file should share one
    # conversion instead of re-converting every time a file gets renamed
    # (confirmed this actually happens -- see the "Sebastian"/"male" rename
    # earlier in this project's history).
    digest = hashlib.sha256(Path(model_path).read_bytes()).hexdigest()[:16]
    return HUBERT_CACHE_DIR / "converted" / digest


def _patch_hf_rvc_weight_norm_mapping():
    # hf_rvc's extract_hubert_state() key-mapping table predates PyTorch's
    # switch to parametrized weight_norm (torch.nn.utils.parametrizations
    # .weight_norm): a freshly-constructed HubertForCTC on current
    # torch/transformers names these weights
    # "...conv.parametrizations.weight.original0/1", but hf_rvc's MAPPING
    # only ever renames the *prefix* (encoder.pos_conv.0 ->
    # encoder.pos_conv_embed.conv) and never touches the weight_g/weight_v
    # suffix, so the renamed key never matches and loading fails with
    # "Missing key(s)" / "Unexpected key(s)".
    #
    # `from ..converters.convert_hubert import extract_hubert_state` in
    # convert_rvc.py binds the name into *that* module's own namespace at
    # import time, so patching convert_hubert.extract_hubert_state itself
    # (where it's defined) wouldn't affect convert_rvc's already-bound
    # reference -- this patches convert_rvc's copy of the name instead,
    # which is what convert_rvc() actually calls.
    import re
    import sys
    # Both `from hf_rvc.converters import convert_rvc` AND
    # `import hf_rvc.converters.convert_rvc as x` resolve through attribute
    # lookup on the parent package -- and converters/__init__.py's own
    # `from .convert_rvc import convert_rvc` overwrites the `convert_rvc`
    # *attribute* on the converters package with the function, shadowing
    # the submodule of the same name. sys.modules is keyed by the fully
    # qualified dotted name and is never touched by that shadowing, so it's
    # the only reliable way to reach the actual submodule object here.
    import hf_rvc.converters.convert_rvc  # ensures it's registered below, even though the bound name here is the shadowed function
    convert_rvc_module = sys.modules["hf_rvc.converters.convert_rvc"]
    from hf_rvc.converters.convert_hubert import extract_hubert_state as original_extract_hubert_state

    def patched_extract_hubert_state(config_or_model, fairseq_hubert):
        from transformers import HubertForCTC

        fairseq_state_dict = fairseq_hubert.state_dict()
        if isinstance(config_or_model, HubertForCTC):
            hf_hubert_model = config_or_model
        else:
            hf_hubert_model = HubertForCTC(config_or_model)
        hf_state_dict = hf_hubert_model.state_dict()

        # Same MAPPING as upstream, plus the two parametrized-weight_norm
        # keys it's missing.
        mapping = {
            r"post_extract_proj": r"feature_projection.projection",
            r"encoder\.pos_conv\.0\.weight_g": r"encoder.pos_conv_embed.conv.parametrizations.weight.original0",
            r"encoder\.pos_conv\.0\.weight_v": r"encoder.pos_conv_embed.conv.parametrizations.weight.original1",
            r"encoder.pos_conv.0": r"encoder.pos_conv_embed.conv",
            r"encoder\.layers\.([0-9]+)\.self_attn.k_proj": r"encoder.layers.\1.attention.k_proj",
            r"encoder\.layers\.([0-9]+)\.self_attn.v_proj": r"encoder.layers.\1.attention.v_proj",
            r"encoder\.layers\.([0-9]+)\.self_attn.q_proj": r"encoder.layers.\1.attention.q_proj",
            r"encoder\.layers\.([0-9]+)\.self_attn.out_proj": r"encoder.layers.\1.attention.out_proj",
            r"encoder\.layers\.([0-9]+)\.self_attn_layer_norm": r"encoder.layers.\1.layer_norm",
            r"encoder\.layers\.([0-9]+)\.fc1": r"encoder.layers.\1.feed_forward.intermediate_dense",
            r"encoder\.layers\.([0-9]+)\.fc2": r"encoder.layers.\1.feed_forward.output_dense",
            r"encoder\.layers\.([0-9]+)\.final_layer_norm": r"encoder.layers.\1.final_layer_norm",
            r"encoder.layer_norm": r"encoder.layer_norm",
            r"w2v_model.layer_norm": r"feature_projection.layer_norm",
            r"w2v_encoder.proj": r"lm_head",
            r"mask_emb": r"masked_spec_embed",
            r"final_proj\.": r"lm_head.",
            r"layer_norm\.": r"feature_projection.layer_norm.",
            r"feature_extractor\.conv_layers\.([0-9]+)\.0\.": r"feature_extractor.conv_layers.\1.conv.",
            r"feature_extractor\.conv_layers\.0\.2\.": r"feature_extractor.conv_layers.0.layer_norm.",
        }

        required_keys = set(hf_state_dict.keys())

        def _convert_key(key):
            if key in hf_state_dict:
                return key
            if f"hubert.{key}" in hf_state_dict:
                return f"hubert.{key}"
            for pattern, repl in mapping.items():
                replaced = re.sub(pattern, repl, key)
                if replaced in hf_state_dict:
                    return replaced
                if f"hubert.{replaced}" in hf_state_dict:
                    return f"hubert.{replaced}"
            return key

        remove_keys = {"label_embs_concat"}
        converted_dict = {_convert_key(k): v for k, v in fairseq_state_dict.items() if k not in remove_keys}
        return converted_dict

    convert_rvc_module.extract_hubert_state = patched_extract_hubert_state
    return original_extract_hubert_state


def _retrieve_blend(features, index, big_npy, rate, k=8):
    # RVC's actual "retrieval" step: for every content-feature frame, find
    # its k nearest neighbours among the target voice's own training
    # features (stored in the .index the model folder ships alongside the
    # .pth), inverse-distance-weight them, and blend that retrieved vector
    # back in at `rate`. This is what makes a converted voice sound like
    # the *specific* target speaker rather than a generic HuBERT-average
    # rendering of their timbre -- skipping it (as hf_rvc's inference path
    # does; it has no faiss dependency at all) still produces valid speech,
    # just less similar to the target.
    import numpy as np
    npy = features.squeeze(0).cpu().numpy().astype("float32")
    score, ix = index.search(npy, k)
    weight = np.square(1 / (score + 1e-9))
    weight /= weight.sum(axis=1, keepdims=True)
    retrieved = np.sum(big_npy[ix] * np.expand_dims(weight, axis=2), axis=1)
    blended = rate * retrieved + (1 - rate) * npy
    return torch.from_numpy(blended).unsqueeze(0).to(features.dtype)


def _patch_hf_rvc_v2_support():
    # hf_rvc's vits/models.py only ever implements TextEncoder256 (a
    # hardcoded nn.Linear(256, hidden_channels) phone embedding) --
    # RVC-Project's real v1/v2 split is nothing more than that one Linear
    # layer's input width (256 vs 768, matching whether content features
    # come from a HuBERT layer projected down or used at full width), but
    # hf_rvc never ported the 768 variant. Confirmed straight from the
    # checkpoint: it carries an explicit top-level "version": "v2" key
    # (separate from the numeric "config" array, which doesn't encode this
    # itself), so detection doesn't need to guess from tensor shapes.
    import sys
    from hf_rvc.models.vits.models import SynthesizerTrnMs256NSFsid, SynthesizerTrnMs256NSFsidConfig
    from hf_rvc.models.modeling_rvc import RVCModel
    import hf_rvc.converters.convert_rvc  # ensure it's registered in sys.modules (see the shadowing note above)
    convert_rvc_module = sys.modules["hf_rvc.converters.convert_rvc"]

    import torch.nn as nn

    TextEncoder256 = SynthesizerTrnMs256NSFsid.__init__.__globals__["TextEncoder256"]

    class TextEncoder768(TextEncoder256):
        # Real subclassing rather than copying TextEncoder256.__init__ onto
        # an unrelated class -- that function's body uses zero-arg super(),
        # which Python resolves via a compile-time __class__ cell bound to
        # TextEncoder256 itself; called on a `self` that isn't actually a
        # TextEncoder256 instance, that super() call raises "obj must be an
        # instance or subtype of type" (confirmed live). True inheritance
        # sidesteps this: super().__init__() here legitimately targets
        # TextEncoder256, since self really is one, and only the phone
        # embedding needs replacing afterward -- forward() is inherited
        # unchanged since it doesn't hardcode a dimension anywhere.
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.emb_phone = nn.Linear(768, self.hidden_channels)

    class SynthesizerTrnMs768NSFsid(SynthesizerTrnMs256NSFsid):
        config_class = SynthesizerTrnMs256NSFsidConfig  # same config shape; only enc_p's input width differs

        def __init__(self, config, **kwargs):
            super().__init__(config, **kwargs)
            self.enc_p = TextEncoder768(
                config.inter_channels,
                config.hidden_channels,
                config.filter_channels,
                config.n_heads,
                config.n_layers,
                config.kernel_size,
                config.p_dropout,
            )

    original_rvcmodel_init = RVCModel.__init__

    def patched_rvcmodel_init(self, config):
        from transformers.modeling_utils import PreTrainedModel as _PTM
        _PTM.__init__(self, config)
        from transformers import HubertConfig, HubertForCTC

        self.hubert = HubertForCTC(
            config.hubert if isinstance(config.hubert, HubertConfig) else HubertConfig(**config.hubert)
        )
        self.add_module("hubert", self.hubert)

        vits_config = (
            config.vits if isinstance(config.vits, SynthesizerTrnMs256NSFsidConfig) else SynthesizerTrnMs256NSFsidConfig(**config.vits)
        )
        # rvc_version isn't a declared constructor field -- PretrainedConfig
        # keeps any extra attribute set on the instance and round-trips it
        # through save_pretrained/from_pretrained, which is exactly what
        # carries this from conversion time (below) to a later inference
        # load (RVCModel.from_pretrained, in convert_voice() above) without
        # needing a separate marker file.
        vits_cls = SynthesizerTrnMs768NSFsid if getattr(vits_config, "rvc_version", "v1") == "v2" else SynthesizerTrnMs256NSFsid
        self.vits = vits_cls(vits_config)
        self.add_module("vits", self.vits)

        import torch as _torch
        self.sid = _torch.tensor([0], dtype=_torch.long)
        self.post_init()

    RVCModel.__init__ = patched_rvcmodel_init

    # RVCModel.forward() feeds self.hubert(input_values).logits into vits --
    # that ".logits" is HubertForCTC's *projected* output (through lm_head,
    # width = the pretraining vocab_size baked into HubertConfig), which
    # matches RVC v1's 256-wide content features by construction. RVC v2
    # instead consumes HuBERT's raw pre-projection hidden state (768-wide),
    # confirmed live: feeding logits into a v2 model's 768-wide emb_phone
    # threw "mat1 and mat2 shapes cannot be multiplied (620x256 and
    # 768x192)" -- the enc_p fix alone wasn't sufficient, forward() also
    # needs to know which one to hand it.
    def patched_forward(self, input_values, f0_coarse, f0):
        import torch as _torch
        if isinstance(self.vits, SynthesizerTrnMs768NSFsid):
            # HubertForCTC.forward() squeezes input_values to 2D
            # (batch, samples) before handing it to its own internal
            # self.hubert submodule -- calling that submodule directly
            # skips that step, so a (1, 1, samples) tensor reaches
            # HubertModel.forward() unprocessed and it rejects the extra
            # axis ("too many dimensions", confirmed live).
            hubert_input = input_values.squeeze(1) if input_values.dim() == 3 else input_values
            features = self.hubert.hubert(hubert_input).last_hidden_state
        else:
            features = self.hubert(input_values).logits
        # Retrieval blending (the "R" in RVC) happens on the raw per-frame
        # content features, before repeat_interleave doubles the frame rate
        # to match vits's hop size -- same ordering as RVC-Project's own
        # vc_infer_pipeline.py. self._retrieval_index is set by
        # convert_voice() below (optional: only present when the user
        # supplied a .index file), never a constructor argument, since
        # RVCModel.forward's call signature is fixed by hf_rvc's own
        # model(**inputs) convention and can't take extra parameters.
        if getattr(self, "_retrieval_index", None) is not None:
            features = _retrieve_blend(
                features, self._retrieval_index, self._retrieval_big_npy, self._retrieval_rate
            )
        features = features.repeat_interleave(2, dim=1)
        phone_lengths = features.shape[-2]
        output, *_ = self.vits.infer(
            features,
            _torch.tensor([phone_lengths]),
            f0_coarse[:, :phone_lengths],
            f0[:, :phone_lengths],
            self.sid,
        )
        return output

    RVCModel.forward = patched_forward

    original_convert_rvc = convert_rvc_module.convert_rvc

    def patched_convert_rvc(vits_path, save_directory=None, hubert_path="./models/hubert_base", f0_method="pm", unsafe=False, safe_serialization=True):
        from hf_rvc.converters.convert_hubert import extract_hubert_config, load_fairseq_hubert
        from hf_rvc.converters.convert_vits import extract_vits_config, extract_vits_state, load_vits_checkpoint
        from hf_rvc.models.configuration_rvc import RVCConfig
        from hf_rvc.models.feature_extraction_rvc import RVCFeatureExtractor
        from transformers import HubertConfig, HubertForCTC

        if save_directory is None:
            p = Path(vits_path)
            save_directory = p.parent / p.stem

        if Path(hubert_path).is_file():
            fairseq_hubert = load_fairseq_hubert(str(hubert_path), unsafe)
            hubert_config = extract_hubert_config(fairseq_hubert)
            hubert_state = convert_rvc_module.extract_hubert_state(hubert_config, fairseq_hubert)
        else:
            hubert_config = HubertConfig.from_pretrained(hubert_path)
            hubert_model = HubertForCTC.from_pretrained(hubert_path)
            hubert_state = hubert_model.state_dict()

        vits_checkpoint = load_vits_checkpoint(vits_path)
        vits_config = extract_vits_config(vits_checkpoint)
        vits_config.rvc_version = vits_checkpoint.get("version", "v1")
        vits_state = extract_vits_state(vits_checkpoint)

        model = RVCModel(RVCConfig(hubert=hubert_config, vits=vits_config))
        model.hubert.load_state_dict(hubert_state)
        model.vits.load_state_dict(vits_state, strict=False)

        if save_directory:
            model.save_pretrained(save_directory, safe_serialization=safe_serialization)

        feature_extractor = RVCFeatureExtractor(f0_method=f0_method)
        feature_extractor.save_pretrained(save_directory, safe_serialization=safe_serialization)
        return model

    convert_rvc_module.convert_rvc = patched_convert_rvc
    return original_convert_rvc


def ensure_converted(model_path: str) -> Path:
    out_dir = converted_model_dir(model_path)
    if (out_dir / "config.json").exists():
        return out_dir
    hubert_path = ensure_hubert_base()
    out_dir.parent.mkdir(parents=True, exist_ok=True)

    import sys
    import hf_rvc.converters.convert_rvc
    convert_rvc_module = sys.modules["hf_rvc.converters.convert_rvc"]
    convert_rvc_module.convert_rvc(vits_path=model_path, save_directory=str(out_dir), hubert_path=str(hubert_path), unsafe=True)
    return out_dir


def convert_voice(input_path: str, model_path: str, output_path: str, index_path: str = None, pitch_shift: int = 0, index_rate: float = 0.75) -> dict:
    # Both patches mutate global state (RVCModel.__init__ is a shared class
    # attribute; extract_hubert_state/convert_rvc are shadowed submodule
    # attributes) -- they must run before *any* RVCModel construction this
    # process does, not just the fresh-conversion path inside
    # ensure_converted(). A cache hit there skips straight to
    # RVCModel.from_pretrained() below, which needs the same patched
    # __init__ to reconstruct a v2 model's shape correctly; applying the
    # patches only on the miss path left a real, confirmed-live bug where a
    # cached v2 model silently reloaded as v1 and failed on this exact
    # size-mismatch every time the cache was warm.
    #
    # fairseq's own checkpoint_utils (called internally by hf_rvc's
    # load_fairseq_hubert) predates PyTorch 2.6's weights_only=True default
    # and doesn't pass weights_only=False itself, so torch.load rejects the
    # fairseq.data.dictionary.Dictionary class embedded in hubert_base.pt --
    # this is PyTorch's own suggested fix (allowlist the specific class)
    # rather than disabling the safety check globally. hf_rvc's own
    # `unsafe=True` flag only gates hf_rvc's *own* check; it can't reach
    # into fairseq's separate torch.load call to change its behavior.
    from fairseq.data.dictionary import Dictionary
    torch.serialization.add_safe_globals([Dictionary])
    _patch_hf_rvc_weight_norm_mapping()
    _patch_hf_rvc_v2_support()

    try:
        model_dir = ensure_converted(model_path)
        feature_extractor = RVCFeatureExtractor.from_pretrained(str(model_dir))
        model = RVCModel.from_pretrained(str(model_dir))
        model.eval()

        # index_path is optional -- the dashboard auto-detects a same-folder
        # .index next to the .pth (see dashboard:pick-voice-model in
        # main.js) but plenty of community models are shared without one.
        # faiss is likewise optional infrastructure only this retrieval path
        # needs; its absence shouldn't break the base conversion, which
        # still works (just without the similarity boost) -- same as RVC
        # WebUI's own "index_rate=0 skips retrieval" behaviour.
        model._retrieval_index = None
        if index_path and Path(index_path).exists():
            try:
                import faiss
                index = faiss.read_index(index_path)
                model._retrieval_index = index
                model._retrieval_big_npy = index.reconstruct_n(0, index.ntotal)
                model._retrieval_rate = index_rate
            except ImportError:
                print(json.dumps({"warning": "faiss 未安装，跳过 .index 特征检索（不影响基础换声）"}), file=sys.stderr)
            except Exception as e:
                print(json.dumps({"warning": f".index 文件加载失败，跳过特征检索: {e}"}), file=sys.stderr)

        audio, sr = sf.read(input_path)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)  # downmix to mono -- RVC expects single-channel input

        # The feature extractor's config is baked in at 16kHz (this is
        # HuBERT's own training rate, not something the RVC model file
        # controls) -- confirmed live it hard-rejects anything else rather
        # than resampling itself, so any other input rate (Demucs's own
        # output is commonly 44.1kHz) needs resampling first.
        target_sr = getattr(feature_extractor, "sampling_rate", 16000)
        if sr != target_sr:
            import librosa
            audio = librosa.resample(audio.astype("float32"), orig_sr=sr, target_sr=target_sr)
            sr = target_sr

        inputs = feature_extractor(audio, sampling_rate=sr, f0_up_key=pitch_shift, return_tensors="pt")

        # The vits decoder (SynthesizerTrnMs*.infer, upstream RVC code
        # unchanged by either patch above) samples fresh Gaussian noise via
        # torch.randn_like() on *every* call as part of its normal
        # architecture -- there's no seed control anywhere in the RVC
        # ecosystem for this. Confirmed live across 8 identical back-to-back
        # calls (same audio, same pitch_shift): ~1 in 8 draws sends the
        # decoder into a numerically unstable region where the whole output
        # saturates at the waveform's +-1.0 ceiling (std ~0.5, vs ~0.06 for
        # a normal draw) -- audibly a harsh buzz, not degraded singing.
        # Since a fresh call redraws the noise independently, a bad draw is
        # simply retried rather than shipped; a real content/shape bug would
        # reproduce identically on retry and isn't masked by this.
        def _is_saturated(samples):
            return (abs(samples) >= 0.999).mean() > 0.05

        with torch.no_grad():
            output = model(**inputs).numpy()
            for _ in range(4):
                if not _is_saturated(output):
                    break
                output = model(**inputs).numpy()

        # The vocoder's raw output is (batch, channel, samples) -- soundfile
        # only accepts (samples,) or (samples, channels), confirmed live
        # ("Invalid shape: (1, 1, N) (too many dimensions)" is soundfile's
        # own error, not a model-side failure). Batch and channel are both
        # 1 here (mono, single clip), so squeezing down to 1-D is exactly
        # the waveform, no data reordering needed.
        output = output.squeeze()

        # feature_extractor.sampling_rate (16kHz) is the *input* rate HuBERT
        # was trained on -- the vits vocoder upsamples internally and emits
        # audio at its own separate, much higher rate (48kHz per the
        # checkpoint's vits.sr config field, confirmed live). Writing the
        # output with the extractor's rate mislabels 48kHz-worth of samples
        # as 16kHz, which doesn't corrupt the audio data itself but makes
        # every player report/derive a duration 3x too long (48000/16000).
        output_sr = getattr(model.vits.config, "sr", None) or (feature_extractor.sampling_rate if hasattr(feature_extractor, "sampling_rate") else sr)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_path, output, output_sr)

        if not Path(output_path).exists():
            return {"error": f"转换完成但找不到输出文件: {output_path}"}

        return {"output": output_path}
    except Exception as e:
        return {"error": str(e)}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: python voice-convert.py <input_audio> <model_pth_path> <output_path> [index_path] [pitch_shift] [index_rate]"}), file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    model_path = sys.argv[2]
    output_path = sys.argv[3]
    index_path = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    pitch_shift = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else 0
    index_rate = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] else 0.75

    if not Path(input_path).exists():
        print(json.dumps({"error": f"输入音频不存在: {input_path}"}), file=sys.stderr)
        sys.exit(1)
    if not Path(model_path).exists():
        print(json.dumps({"error": f"模型文件不存在: {model_path}"}), file=sys.stderr)
        sys.exit(1)

    result = convert_voice(input_path, model_path, output_path, index_path, pitch_shift, index_rate)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
