/**
 * grants.mjs —— 能力授权（默认什么都没有）
 *
 * 这个模块里没有任何能力是默认可用的。装上之后她只能发呆、想事情、歇着；
 * 要让她碰手机、要让她能调模型做决策，都得主人**在面板里一项一项手动打开**。
 *
 * 为什么这么做：`module.json` 的 capabilities 是静态声明，只能写「我最坏能用什么」。
 * 写空了表示「默认一项都不用」，而真正能不能用由这里的 grants 说了算。
 * 两道对齐，才不会出现「声明说不用、代码偷偷用」。
 *
 * 授权存在 settings.grants 里，是普通对象，面板改完立即生效。
 */

/** 每一项能力：id、面板上怎么解释、对应 module.json 的哪个 capability */
export const GRANTS = [
  {
    id: 'model',
    title: '调用模型做决策',
    capability: 'plugin-internals',
    risk: '中',
    detail:
      '她每一轮要「自己想做什么」就需要问一次模型。不开这一项，她只会发呆和歇着，不会做任何决定。开启后每小时可能消耗几十次小请求。',
  },
  {
    id: 'phone',
    title: '操作连着的那台手机',
    capability: 'process',
    risk: '高',
    detail:
      '会通过 adb 读写手机状态：查电量和锁屏、模拟点击滑动、往 sdcard 写她自己的日记。命令走白名单（只有固定的十几个 adb 子命令），但它是真能碰到你设备的。',
  },
]

const IDS = new Set(GRANTS.map((g) => g.id))

/** 当前已授权的集合（永远返回新对象，调用方改了不影响设置） */
export function grantsOf(settings) {
  const raw = settings && settings.grants
  const out = {}
  for (const g of GRANTS) out[g.id] = !!(raw && raw[g.id])
  return out
}

/** 某一项有没有打开 */
export function isGranted(settings, id) {
  if (!IDS.has(id)) return false
  const raw = settings && settings.grants
  return !!(raw && raw[id])
}

/**
 * 用某能力之前调它。没授权就抛——调用方应当接住并降级，而不是继续硬跑。
 * 错误信息是给人看的，直接写进活动流水也没问题。
 */
export function requireGrant(settings, id) {
  const g = GRANTS.find((x) => x.id === id)
  if (!g) throw new Error(`未知能力：${id}`)
  if (!isGranted(settings, id)) {
    throw new Error(`「${g.title}」还没授权（面板 → 自主生活 → 权限，一项一项打开）`)
  }
  return true
}

/** 面板用：把当前授权状态整理成可渲染的列表 */
export function grantRows(settings) {
  const cur = grantsOf(settings)
  return GRANTS.map((g) => ({ ...g, granted: cur[g.id] }))
}
