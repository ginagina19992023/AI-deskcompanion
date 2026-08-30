// Central translation table for the dashboard's "chrome" -- sidebar nav
// labels and each section's <h2>/<p class="subtitle"> pair. Keyed by the
// same string already used as each nav button's data-section attribute
// and each section's id="section-<key>" suffix, so applying a language
// needs no extra data-i18n markup in the HTML: just look up by the key
// that's already there.
//
// Deliberately scoped to nav + headers/subtitles, not every field label
// and hint paragraph in the file (that's several hundred strings across a
// 2000+ line document) -- this covers what actually reads as "the
// interface language" when switching, and is the part visible without
// scrolling into a specific settings group.
export const DASHBOARD_I18N = {
  zh: {
    appTitle: '桌面宠物控制面板',
    sidebarFooter: '改动即时生效，不用重启',
    navGroupSettings: '设置',
    navGroupCharacter: '形象与手势',
    navGroupRecords: '记录与数据',
    nav: {
      overview: '概览',
      chat: '💬 聊天',
      appearance: '外观',
      voicechat: '语音与聊天',
      models: '模型',
      automation: '自动化',
      toggles: '互动细节',
      shortcuts: '快捷键',
      characters: '形象',
      gestures: '手势',
      memory: '记忆',
      todos: '待办',
      tasks: 'AI 任务',
      history: '记录',
      report: '报告',
      vocal: '🎤 唱歌',
    },
    h2: {
      overview: '概览',
      appearance: '外观',
      voicechat: '语音与聊天',
      models: '模型',
      automation: '自动化',
      toggles: '互动细节',
      shortcuts: '快捷键',
      characters: '形象',
      memory: '记忆',
      gestures: '手势',
      todos: '待办',
      tasks: 'AI 任务',
      history: '记录',
      report: '报告',
      vocal: '🎤 唱歌',
    },
    subtitle: {
      appearance: '控制面板和桌宠身上的颜色、透明度、缩放、提示音——纯粹跟"好不好看/吵不吵"有关的设置都在这',
      vocal: '用 MiMo 云端语音的"唱歌模式"合成——跟平时说话走同一个 API，只是歌词前面自动加了唱歌标签，不需要额外配置，需要先在「语音与聊天」页填好 MiMo API Key。',
    },
  },
  en: {
    appTitle: 'Desktop Pet Control Panel',
    sidebarFooter: 'Changes apply instantly, no restart needed',
    navGroupSettings: 'Settings',
    navGroupCharacter: 'Character & Gestures',
    navGroupRecords: 'Records & Data',
    nav: {
      overview: 'Overview',
      chat: '💬 Chat',
      appearance: 'Appearance',
      voicechat: 'Voice & Chat',
      models: 'Models',
      automation: 'Automation',
      toggles: 'Interaction',
      shortcuts: 'Shortcuts',
      characters: 'Character',
      gestures: 'Gestures',
      memory: 'Memory',
      todos: 'Todo',
      tasks: 'AI Tasks',
      history: 'History',
      report: 'Reports',
      vocal: '🎤 Singing',
    },
    h2: {
      overview: 'Overview',
      appearance: 'Appearance',
      voicechat: 'Voice & Chat',
      models: 'Models',
      automation: 'Automation',
      toggles: 'Interaction',
      shortcuts: 'Shortcuts',
      characters: 'Character',
      memory: 'Memory',
      gestures: 'Gestures',
      todos: 'Todo',
      tasks: 'AI Tasks',
      history: 'History',
      report: 'Reports',
      vocal: '🎤 Singing',
    },
    subtitle: {
      appearance: 'Colors, opacity, scale, and notification sounds for the control panel and desktop pet -- everything purely about "how it looks / how loud it is" lives here.',
      vocal: 'Generate singing using MiMo Cloud "singing mode" - uses same API as voice chat, auto-adds singing tags to lyrics, requires MiMo API Key in Voice & Chat settings.',
    },
  },
};
