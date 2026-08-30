// Internationalization (i18n) module for UI strings
// Supports Chinese (zh) and English (en)

const translations = {
  zh: {
    // Page sections
    sectionOverview: '概览',
    sectionAppearance: '外观',
    sectionVoiceChat: '语音与聊天',
    sectionModels: '模型',
    sectionAutomation: '自动化',
    sectionInteraction: '互动细节',
    sectionShortcuts: '快捷键',
    sectionCharacter: '形象',
    sectionMemory: '记忆',
    sectionGestures: '手势',
    sectionTodo: '待办',
    sectionTasks: 'AI 任务',
    sectionRecords: '记录',
    sectionReports: '报告',

    // Dashboard tabs
    tabSettings: '设置',
    tabChat: '聊天',
    tabMemory: '记忆',
    tabShortcuts: '快捷键',

    // Voice settings
    sectionVoice: '声音',
    voiceEngine: '语音引擎',
    engineSapi: 'Windows SAPI',
    enginePiper: 'Piper (本地)',
    engineEdgeCloud: 'Edge (云端)',
    voiceSelection: '音色',
    voiceEnglish: '英文音色',
    voiceChinese: '中文音色',
    speechRate: '语速',
    speakingSpeed: '说话速度',
    voicePreview: '试听',

    // Appearance settings
    sectionAppearanceSettings: '外观',
    uiLanguage: '界面语言',
    languageChinese: '中文',
    languageEnglish: 'English',
    theme: '主题',
    panelOpacity: '面板透明度',
    fontSize: '字体大小',

    // General settings
    sectionGeneral: '常规',
    autoStart: '开机启动',
    stayOnTop: '始终置顶',
    enableNotifications: '启用通知',

    // Chat section
    sectionChat: '对话',
    chatProvider: '对话提供方',
    chatModel: '模型',
    enableVoiceMode: '启用语音模式',
    systemPrompt: '系统提示词',

    // Memory section
    sectionMemory: '记忆管理',
    clearAll: '清空所有',
    deleteSelected: '删除选中',
    confirmClear: '确认要清空所有记忆吗？',

    // Shortcuts section
    sectionShortcuts: '快捷键设置',
    recordShortcut: '录制',
    resetShortcut: '重置',

    // Common buttons
    buttonSave: '保存',
    buttonCancel: '取消',
    buttonApply: '应用',
    buttonClose: '关闭',
    buttonDelete: '删除',
    buttonAdd: '添加',
    buttonEdit: '编辑',

    // Messages
    messageSaved: '已保存',
    messageError: '出错了',
    messageLoading: '加载中...',
    messageSetting: '设置中...',
    messageConfirm: '确认',
    messageOk: '确定',
    messageCancel: '取消',
  },
  en: {
    // Page sections
    sectionOverview: 'Overview',
    sectionAppearance: 'Appearance',
    sectionVoiceChat: 'Voice & Chat',
    sectionModels: 'Models',
    sectionAutomation: 'Automation',
    sectionInteraction: 'Interaction',
    sectionShortcuts: 'Shortcuts',
    sectionCharacter: 'Character',
    sectionMemory: 'Memory',
    sectionGestures: 'Gestures',
    sectionTodo: 'Todo',
    sectionTasks: 'AI Tasks',
    sectionRecords: 'Records',
    sectionReports: 'Reports',

    // Dashboard tabs
    tabSettings: 'Settings',
    tabChat: 'Chat',
    tabMemory: 'Memory',
    tabShortcuts: 'Shortcuts',

    // Voice settings
    sectionVoice: 'Voice',
    voiceEngine: 'Voice Engine',
    engineSapi: 'Windows SAPI',
    enginePiper: 'Piper (Local)',
    engineEdgeCloud: 'Edge (Cloud)',
    voiceSelection: 'Voice',
    voiceEnglish: 'English Voice',
    voiceChinese: 'Chinese Voice',
    speechRate: 'Speech Rate',
    speakingSpeed: 'Speaking Speed',
    voicePreview: 'Preview',

    // Appearance settings
    sectionAppearanceSettings: 'Appearance',
    uiLanguage: 'UI Language',
    languageChinese: '中文',
    languageEnglish: 'English',
    theme: 'Theme',
    panelOpacity: 'Panel Opacity',
    fontSize: 'Font Size',

    // General settings
    sectionGeneral: 'General',
    autoStart: 'Auto Start',
    stayOnTop: 'Stay on Top',
    enableNotifications: 'Enable Notifications',

    // Chat section
    sectionChat: 'Chat',
    chatProvider: 'Chat Provider',
    chatModel: 'Model',
    enableVoiceMode: 'Enable Voice Mode',
    systemPrompt: 'System Prompt',

    // Memory section
    sectionMemory: 'Memory Management',
    clearAll: 'Clear All',
    deleteSelected: 'Delete Selected',
    confirmClear: 'Are you sure you want to clear all memories?',

    // Shortcuts section
    sectionShortcuts: 'Shortcut Keys',
    recordShortcut: 'Record',
    resetShortcut: 'Reset',

    // Common buttons
    buttonSave: 'Save',
    buttonCancel: 'Cancel',
    buttonApply: 'Apply',
    buttonClose: 'Close',
    buttonDelete: 'Delete',
    buttonAdd: 'Add',
    buttonEdit: 'Edit',

    // Messages
    messageSaved: 'Saved',
    messageError: 'Error',
    messageLoading: 'Loading...',
    messageSetting: 'Setting...',
    messageConfirm: 'Confirm',
    messageOk: 'OK',
    messageCancel: 'Cancel',
  }
};

let currentLanguage = 'zh';

export function setLanguage(lang) {
  if (translations[lang]) {
    currentLanguage = lang;
    return true;
  }
  return false;
}

export function getLanguage() {
  return currentLanguage;
}

export function t(key) {
  return translations[currentLanguage]?.[key] ?? translations['zh']?.[key] ?? key;
}

export function getSupportedLanguages() {
  return Object.keys(translations);
}
