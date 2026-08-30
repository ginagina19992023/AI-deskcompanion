# ChatTTS 集成笔记

## 安装状态
✅ ChatTTS 0.2.5 已安装
✅ PyTorch + torchaudio 已安装
✅ 依赖库 (requests, safetensors, numpy) 已安装

## API 更正
当前 wrapper 使用了旧 API，需要更新：

```python
# 旧 API (现在已过期)
chat = ChatTTS.ChatTTS()
chat.load_models(device=device)

# 新 API (0.2.5)
from ChatTTS import Chat
chat = Chat()
chat.download_models(device=device)  # 首次运行会从HuggingFace下载
result = chat.infer("文本内容")
```

## 下一步
1. 更新 src/voice-tts-chattts.js 中的 Python 脚本使用新 API
2. 测试中文合成质量
3. 集成到应用的 TTS 降级链

## 测试候选文本
- "晚上好，少爷。今天过得还算体面吧？"
- "是啊，少爷。"
- "我永远是您最忠诚的仆人。"
