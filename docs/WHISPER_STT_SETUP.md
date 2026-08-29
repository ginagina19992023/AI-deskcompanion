# 本地 Whisper 语音识别 —— 安装说明

默认的语音识别引擎是 Windows 自带的 SAPI，零配置但中文准确率一般。切换成本地 Whisper（whisper.cpp）能明显提升准确率，代价是需要下载一次模型和可执行文件。

## 已经准备好的部分（这个仓库自带，不用你做）

- `tools/mic-record/mic-record.exe`：真实 WASAPI 麦克风录音，已编译好，已验证能打开麦克风并生成标准 16kHz 单声道 WAV 文件
- `src/voice-stt-whisper.js`：主进程侧的整合代码，跟 SAPI 引擎接口完全一致，配置里切一下 `voice.sttEngine` 就能换
- Dashboard 设置里"语音识别引擎"下拉框已经接好

## 你需要做的部分

Whisper 的可执行文件和模型文件因为体积较大（几十到几百 MB），没有直接打进仓库。下载完成后放到指定位置即可：

1. **下载 whisper.cpp 可执行文件**（约 8-20MB，选纯 CPU 版即可，这台机器没有独立显卡）：
   - 打开 https://github.com/ggerganov/whisper.cpp/releases/latest
   - 下载 `whisper-blas-bin-x64.zip`（BLAS 加速版，纯 CPU 推理下更快）
   - 解压后找到 `whisper-cli.exe`（旧版本可能叫 `main.exe`），放到：
     `tools/whisper/whisper-cli.exe`

2. **下载模型文件**（体积较大，务必用稳定的网络，用哪个模型看你要多准/多快）：
   - `ggml-base.bin`（约 142MB，速度快，默认配置用这个）：
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
   - 或 `ggml-small.bin`（约 488MB，中文准确率明显更好，纯 CPU 推理下更慢）：
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
   - 下载好后放到：
     `tools/whisper/models/ggml-base.bin`（或 `ggml-small.bin`，文件名随意，改配置指到它就行）

3. **切换引擎**：设置窗口 →"聊天"分页 → 语音设置 → "语音识别引擎"选"本地 Whisper"。如果用的是 `ggml-small.bin` 而不是默认的 `ggml-base.bin`，还要在 `config.json` 里把 `voice.whisper.modelPath` 填成那个文件的完整路径。

## 验证装好了没有

在项目根目录跑（PowerShell）：

```powershell
.\tools\whisper\whisper-cli.exe -m .\tools\whisper\models\ggml-base.bin --help
```

能打印出帮助信息说明可执行文件没问题。模型文件路径不对会在你切换引擎后第一次说话时报错，设置面板会把这个错误显示成一条聊天气泡。
