// 抖音写操作失败分类：日志和 state 里带上类别，用户报问题时能一眼看出是验证码 / 风控、
// 页面选择器改了、网络没回执、额度用完，还是发送状态不确定。不是自动修复，只是把排查信息说清楚。

const RISK_RE = /验证|频繁|稍后再试|异常|限制|风控|安全验证|操作频繁|账号异常/
const LOGIN_RE = /没登录|未登录|登录状态|登录失效/
const LIMIT_RE = /次数用完|上限|额度|太密|再等\s*\d/
const UNCERTAIN_RE = /不确定/
const TARGET_RE = /没找到主人|找不到主人|互相没关注|分享面板里没找到/
const SELECTOR_RE = /找不到|没找到|没打开|点不进去|没弹出来|候选|选择器|页面上没有|元素|输入框/
const NETWORK_RE = /没等到|超时|没响应|接口返回|HTTP|网络|连接|加载|空内容|CDN/

/**
 * error → 失败类别：
 * risk 风控/验证码 / login 没登录 / limit 额度或间隔 / uncertain 发送状态不确定 /
 * target 找不到分享或 @ 的对象 / selector 页面结构（选择器） / network 接口网络 / api 业务码 / unknown
 */
export function classifyFailure(error) {
  const message = String(error?.message ?? error ?? '')
  const code = error?.code
  if (code === 'verify') return 'risk'
  // 先判额度 / 间隔：消息里常有「限制」二字（如「今日额度限制」），不能被 RISK_RE 抢成风控。
  if (LIMIT_RE.test(message)) return 'limit'
  if (RISK_RE.test(message)) return 'risk'
  if (code === 'dm_uncertain' || code === 'uncertain' || code === 'share_uncertain' || UNCERTAIN_RE.test(message)) return 'uncertain'
  if (code === 'login' || LOGIN_RE.test(message)) return 'login'
  if (TARGET_RE.test(message)) return 'target'
  if (SELECTOR_RE.test(message)) return 'selector'
  if (NETWORK_RE.test(message)) return 'network'
  if (typeof code === 'number' && code !== 0) return 'api'
  return 'unknown'
}

/** 一行日志：动作 + 类别 + 视频 id（有的话）+ 原始错误。 */
export function describeFailure(action, error, extra = {}) {
  const kind = classifyFailure(error)
  const awemeId = extra.awemeId ? ` aweme=${extra.awemeId}` : ''
  const uid = extra.uid ? ` uid=${extra.uid}` : ''
  return { kind, text: `${action}失败[${kind}]${awemeId}${uid}：${String(error?.message ?? error ?? '')}` }
}
