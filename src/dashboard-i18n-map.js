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
      vocal: '🎙️ 演唱室',
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
      vocal: '🎙️ 演唱室',
    },
    subtitle: {
      appearance: '控制面板和桌宠身上的颜色、透明度、缩放、提示音——纯粹跟"好不好看/吵不吵"有关的设置都在这',
      vocal: '这里有两条独立的路，互不依赖：想让角色直接唱一段自己的词，走下面「原创演唱」，一步到位；想拿一首现成的歌、把原唱换成任意音色（旋律和伴奏都不变），走后面「翻唱」那几步。',
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
      vocal: '🎙️ Singing Studio',
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
      vocal: '🎙️ Singing Studio',
    },
    subtitle: {
      appearance: 'Colors, opacity, scale, and notification sounds for the control panel and desktop pet -- everything purely about "how it looks / how loud it is" lives here.',
      vocal: 'Two independent paths here: to have the character sing your own lyrics, use "Original Singing" below -- one step, done. To take an existing song and swap the singer\'s voice (melody and backing track untouched), use the "Cover" steps further down.',
    },
  },
};
