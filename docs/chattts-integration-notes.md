# ChatTTS 集成笔记

## 状态
⏸️ **暂时禁用**：模型下载在 Windows 环境中遇到网络问题（RVC / HuggingFace 访问限制）
- 症状：`download_models()` 调用卡住或失败，导致应用启动超时
- 影响：中文 TTS 退回到 SAPI 本地合成（虽然音质较低，但仍可用）
- 解决：已在 src/main.js 的 synthesizeSpeechFile() 中注释掉 ChatTTS 调用，改为直接使用 SAPI

## 已完成
✅ ChatTTS 0.2.5 已安装
✅ PyTorch + torchaudio 已安装
✅ 依赖库 (requests, safetensors, numpy) 已安装
✅ 修复了 API 调用（download_models() 和 infer() 签名）
✅ 禁用了 ChatTTS 以避免启动延迟

## 恢复 ChatTTS 的步骤
当 Windows 网络访问 HuggingFace 恢复后：

1. 在 config.json 中配置代理（如果需要）或使用镜像源
2. 在 src/main.js 的第 621-630 行取消注释 ChatTTS 调用
3. 测试 `node src/voice-tts-chattts.js` 直接运行包装脚本
4. 若成功，通过应用重启验证集成

## TTS 降级链（当前可用）
1. **Edge** (云端) - 音质最佳，支持多语言
2. **Piper** (本地) - 备选方案，需要配置
3. ~~ChatTTS~~ (本地中文) - 暂时禁用（模型下载问题）
4. **SAPI** (Windows) - 最后降级方案，始终可用
