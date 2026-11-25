// 八套基础色调：图标人物 + 界面一起换。
// 每套给全量色板，前端只改 CSS 变量，不写死任何颜色。
export const TONES = [
  {
    id: 'ocean',
    name: '深海蓝',
    primary: '#3f86d4',
    deep: '#2a5f9e',
    gradA: '#54a8e6',
    gradB: '#2f6fb8',
    pageA: '#eaf5ff',
    pageB: '#cfe4f7',
    surface: '#ffffff',
    soft: '#f0f7ff',
    text: '#12283f',
    muted: '#6a8399',
    dark: false,
  },
  {
    id: 'sakura',
    name: '樱粉',
    primary: '#e0678f',
    deep: '#b0436a',
    gradA: '#f393b2',
    gradB: '#c9537a',
    pageA: '#fff2f6',
    pageB: '#fbdbe6',
    surface: '#ffffff',
    soft: '#fff5f8',
    text: '#3d1f2b',
    muted: '#9a7080',
    dark: false,
  },
  {
    id: 'mint',
    name: '薄荷绿',
    primary: '#2aa987',
    deep: '#1b7a62',
    gradA: '#57cdaa',
    gradB: '#1e8f72',
    pageA: '#eefbf6',
    pageB: '#d2f1e5',
    surface: '#ffffff',
    soft: '#f2fcf8',
    text: '#12332a',
    muted: '#63897d',
    dark: false,
  },
  {
    id: 'grape',
    name: '葡萄紫',
    primary: '#8168cf',
    deep: '#5b46a0',
    gradA: '#a68fea',
    gradB: '#6a52b8',
    pageA: '#f6f3ff',
    pageB: '#e2daff',
    surface: '#ffffff',
    soft: '#f8f5ff',
    text: '#241c3d',
    muted: '#7d72a0',
    dark: false,
  },
  {
    id: 'sunset',
    name: '落日橙',
    primary: '#e07a3f',
    deep: '#b1562a',
    gradA: '#f5a86b',
    gradB: '#c96a2e',
    pageA: '#fff6ee',
    pageB: '#fbe1cb',
    surface: '#ffffff',
    soft: '#fff8f2',
    text: '#3b2415',
    muted: '#9a7a62',
    dark: false,
  },
  {
    id: 'moon',
    name: '月白',
    primary: '#6f88ab',
    deep: '#4b6180',
    gradA: '#9db3cd',
    gradB: '#5d7595',
    pageA: '#f6f9fc',
    pageB: '#e3eaf3',
    surface: '#ffffff',
    soft: '#f8fbfe',
    text: '#1e2a3a',
    muted: '#74869b',
    dark: false,
  },
  {
    id: 'abyss',
    name: '深海夜',
    primary: '#5f7ddb',
    deep: '#3a4fa0',
    gradA: '#7189e6',
    gradB: '#4a5cb0',
    pageA: '#151b2d',
    pageB: '#0b0f1a',
    surface: '#1e2539',
    soft: '#171d2e',
    text: '#e8eefc',
    muted: '#94a3c4',
    dark: true,
  },
  {
    id: 'rose',
    name: '陈玫',
    primary: '#c94a61',
    deep: '#94283c',
    gradA: '#e57c90',
    gradB: '#a83349',
    pageA: '#fff1f3',
    pageB: '#f8d7dc',
    surface: '#ffffff',
    soft: '#fff5f6',
    text: '#3a1620',
    muted: '#9a6570',
    dark: false,
  },
]

export const DEFAULT_TONE = 'ocean'

export function toneOf(id) {
  return TONES.find((t) => t.id === id) || TONES[0]
}

/** 把色板写到 :root 的 CSS 变量上，界面自动跟着变 */
export function applyTone(id) {
  const t = toneOf(id)
  const r = document.documentElement.style
  const map = {
    '--primary': t.primary,
    '--deep': t.deep,
    '--grad-a': t.gradA,
    '--grad-b': t.gradB,
    '--page-a': t.pageA,
    '--page-b': t.pageB,
    '--surface': t.surface,
    '--soft': t.soft,
    '--text': t.text,
    '--muted': t.muted,
    '--ring': hexA(t.primary, 0.28),
    '--shadow': t.dark ? 'rgba(0,0,0,.45)' : hexA(t.deep, 0.16),
  }
  for (const [k, v] of Object.entries(map)) r.setProperty(k, v)
  document.body.classList.toggle('dark', !!t.dark)
  document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', t.dark ? t.pageB : t.pageA)
  return t
}

function hexA(hex, a) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
