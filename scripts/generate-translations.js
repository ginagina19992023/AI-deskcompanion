// 自动为所有中文文本生成英文翻译的脚本
// 使用中英文词汇映射表进行快速翻译

const vocabularyMap = {
  // 时间相关
  '分钟': 'minute',
  '小时': 'hour',
  '天': 'day',
  '周': 'week',
  '月': 'month',
  '年': 'year',
  '今天': 'Today',
  '最近': 'Recent',

  // 通用操作
  '应用': 'Apply',
  '保存': 'Save',
  '删除': 'Delete',
  '编辑': 'Edit',
  '新增': 'Add',
  '取消': 'Cancel',
  '确认': 'Confirm',
  '关闭': 'Close',
  '打开': 'Open',
  '选择': 'Select',
  '清除': 'Clear',
  '恢复默认': 'Reset to Default',
  '重启': 'Restart',
  '检测': 'Detect',

  // 常见设置词汇
  '语言': 'Language',
  '界面': 'Interface',
  '颜色': 'Color',
  '音量': 'Volume',
  '字体': 'Font',
  '主题': 'Theme',
  '外观': 'Appearance',
  '设置': 'Settings',
  '配置': 'Configuration',
  '模式': 'Mode',
  '方案': 'Scheme',
  '中文': 'Chinese',
  '英文': 'English',

  // 音频相关
  '语音': 'Voice',
  '音效': 'Sound',
  '朗读': 'TTS',
  '引擎': 'Engine',
  '音色': 'Voice',
  '音高': 'Pitch',
  '语速': 'Speed',
  '麦克风': 'Microphone',
  '识别': 'Recognition',

  // 文本相关
  '文字': 'Text',
  '描述': 'Description',
  '标题': 'Title',
  '内容': 'Content',
  '标签': 'Label',
  '提示': 'Hint',

  // 状态词
  '启用': 'Enable',
  '禁用': 'Disable',
  '开启': 'On',
  '关闭': 'Off',
  '成功': 'Success',
  '失败': 'Failed',
  '错误': 'Error',
  '警告': 'Warning',
  '信息': 'Info',
};

// 从 dashboard.html 提取所有中文文本
const fs = require('fs');
const content = fs.readFileSync('D:\\GitHub\\AI-deskcompanion\\src\\dashboard.html', 'utf8');

// 提取所有 h3、p.hint 和 option 标签中的文本
const h3Regex = /<h3>([^<]+)<\/h3>/g;
const hintRegex = /<p class="hint"[^>]*>([^<]+)<\/p>/g;
const optionRegex = /<option[^>]*>([^<]+)<\/option>/g;

const texts = new Set();

let match;
while ((match = h3Regex.exec(content)) !== null) {
  texts.add(match[1].trim());
}
hintRegex.lastIndex = 0;
while ((match = hintRegex.exec(content)) !== null) {
  texts.add(match[1].trim());
}
optionRegex.lastIndex = 0;
while ((match = optionRegex.exec(content)) !== null) {
  texts.add(match[1].trim());
}

console.log(`Found ${texts.size} unique Chinese texts to translate`);

// 生成翻译函数
function simpleTranslate(text) {
  if (!text) return '';

  // 检查是否已经全英文
  if (!/[\u4E00-\u9FFF]/.test(text)) return text;

  // 对于某些特定文本，使用硬编码翻译
  const hardcodedTranslations = {
    '🎤 语音设置': '🎤 Voice Settings',
    '💬 聊天设置': '💬 Chat Settings',
    '👀 干活监督': '👀 Focus Monitor',
    '📝 每日总结 + 记忆整理': '📝 Daily Summary + Memory',
    '📧 Outlook 待办同步': '📧 Outlook Sync',
    '📷 摄像头感知': '📷 Camera Sensing',
    '🖼️ 屏幕提示（截屏 + AI 锐评）': '🖼️ Screen Tips',
    '🎨 生成新形象需求': '🎨 Generate Character',
  };

  if (hardcodedTranslations[text]) {
    return hardcodedTranslations[text];
  }

  // 简单的词汇替换
  let result = text;
  for (const [zh, en] of Object.entries(vocabularyMap)) {
    result = result.split(zh).join(en);
  }

  return result;
}

// 生成翻译表
const translations = {};
for (const text of texts) {
  if (text) {
    translations[text] = simpleTranslate(text);
  }
}

// 输出为 JavaScript 代码
console.log('\n// Generated translations:');
console.log('const generatedTranslations = {');
for (const [zh, en] of Object.entries(translations).slice(0, 20)) {
  console.log(`  '${zh}': '${en}',`);
}
console.log('  // ... more translations');
console.log('};');

console.log(`\nTotal translations generated: ${Object.keys(translations).length}`);
