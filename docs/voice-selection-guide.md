# 音色选择指南 / Voice Selection Guide

## 中文音色对比 (Chinese Voice Comparison)

现已为您生成 4 个中文音色样本供选择。每个音色各有特色：

| 音色 | 风格 | 特点 | 推荐场景 |
|------|------|------|---------|
| **云健** | 激情，运动解说风 | 充满活力，富有感染力 | 热情互动、运动话题 |
| **云希** | 活泼，小说朗读风 | 活跃生动，表现力强 | 讲故事、创意话题 |
| **云霞** | 可爱，动画风 | 甜蜜温柔，轻快活泼 | 日常陪伴、温和交流 |
| **云阳** | 专业，新闻播报风 | 沉稳专业，清晰准确 | 工作相关、严肃话题 |

## 如何试听 / How to Preview

1. 打开 Dashboard 设置 (Open Dashboard → Settings)
2. 进入「外观」标签页 (Go to "Appearance" tab)
3. 找到「声音」部分的「中文音色（Edge）」(Find "中文音色（Edge）" in "Voice" section)
4. 在下拉菜单中选择一个音色 (Select a voice from dropdown)
5. 点击「试听」按钮听样音 (Click "试听" button to preview)

## 生成音色样本 / Generate Voice Samples

如需重新生成所有音色样本：

```bash
python tools/generate-voice-samples.py
```

生成的文件将保存到：`data/voice-samples/`

## 当前推荐 / Current Recommendation

**云阳 (Yunyang)** - 推荐作为默认音色
- 专业沉稳的播报风格，适合 Sebastian 的管家身份
- 清晰准确，易于理解
- 工作和生活话题都适用

## 语音系统架构 / Voice System Architecture

```
用户选择音色 (User selects voice)
         ↓
Dashboard 保存配置 (Config saved)
         ↓
应用启动时加载 (App loads on startup)
         ↓
说话时自动使用 (Used when pet speaks)
```

### TTS 降级链 (Fallback Chain)

1. **Edge (云端)** ← 当前使用
   - 支持多种音色
   - 需要网络连接
   - 音质最好

2. **Piper (本地神经)**
   - 如果配置了模型
   - 完全离线
   - 备选方案

3. **SAPI (Windows系统)**
   - 始终可用
   - 无需配置
   - 最后保障

## 故障排查 / Troubleshooting

### 试听按钮不工作
- 检查网络连接
- 确认已选择音色
- 查看浏览器控制台错误

### 音色列表为空
- 重新启动应用
- 检查 Edge TTS 依赖是否正确安装

### 说话时无声音
- 检查系统音量
- 验证音色配置已保存
- 查看应用日志
