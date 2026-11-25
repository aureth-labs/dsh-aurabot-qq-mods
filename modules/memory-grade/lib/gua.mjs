/**
 * 八卦分类：给记忆标一个「是什么」和一个「怎么用」。
 *
 * 用乾 坤 震 巽 坎 离 艮 兑 八个字，不用六十四卦。
 * 它只是给记忆打个标签，方便整理时分类看，不参与检索排序。
 *
 * 这里给的是**关键词规则版**，纯本地、不联网、不花钱。
 * 想要更准的，可以在自己的模块里接模型，把结果覆盖掉。
 *
 * 用法：
 *   const g = gua(text)
 *   g.upper // '艮'  是什么
 *   g.lower // '乾'  怎么用
 */

/** 上卦：这条记忆在说什么 */
export const UPPER = {
  艮: '边界',
  乾: '规则',
  坎: '技术',
  兑: '人物',
  巽: '偏好',
  离: '情感',
  坤: '事实',
  震: '事件',
}

/** 下卦：这条记忆怎么用 */
export const LOWER = {
  乾: '立规矩',
  坎: '提醒',
  艮: '封存',
  震: '立刻用',
  巽: '慢慢渗',
  兑: '对人说',
  离: '主动说',
  坤: '存着',
}

// ---------- 关键词表 ----------

const RE_BOUND = /(红线|禁止|不许|不能提|保密|机密|隐私|别告诉|家庭身份|真名|本名|喊不出口)/

const RE_RULE = /(以后都|以后每|每次都要|每次.{0,6}都要|必须|约定|规矩|规则|制度|要求|一律|统统|记得要|要一直|都得|都要|不能忘)/

const RE_TECH = /(报错|踩坑|坑|接口|配置|参数|路径|端口|安装|装好|装完|pip|npm|版本|依赖|脚本|命令|函数|库|模块|编码|BOM|UTF-8|gbk|api|token|Cookie|弃用|警告|报|抛错|启动|进程|数据库|sqlite|索引|字段|表)/i

const RE_PERSON = /([\u4e00-\u9fa5]{2,4}（(?:QQ\s*)?\d{5,}）|这个人|那家伙|性格|脾气|习惯爱|喜欢(?![吃看玩的]))/

const RE_PREFER = /(喜欢|爱吃|爱看|口味|风格|审美|偏好|讨厌|不爱|迷上了|追的剧|在玩)/

const RE_FEEL = /(开心|难过|委屈|生气|心疼|感动|害怕|郁闷|高兴|烦|温暖|暖|踏实|想他|想她|被夸|被逗|心软|舍不得|难受|心里|情绪)/

const RE_KNOW = /(^(看了|刷到|读到|热榜|文章|视频)|知识|资料|数据|据说|指的是|是一种|叫做|百科|教程)/

const RE_EVENT = /(今天|昨天|刚才|那天|去了|做了|吃了|见了|聊了|发生了)/

const RE_EXPIRE = /(作废|取消|不做了|算了|过去了|不再提|已删除|已作废)/

const RE_NOW = /(马上|今天要|现在要|这轮|待会|等会儿|一会儿|立刻|今晚|紧接着)/

const RE_TALK = /(可以聊|当谈资|拿来分享|挺有意思|回头跟|跟.{1,6}说说)/

const RE_TO_PERSON = /(只在跟|对.{1,6}说的时候|跟他说话|跟她说话)/

/**
 * 给一段文字判八卦。
 * 先判上卦（是什么），再判下卦（怎么用）。
 */
export function gua(text) {
  const t = String(text || '')
  if (!t.trim()) return { upper: '坤', lower: '坤', reason: '空' }

  // ---- 上卦，按优先级：艮 > 乾 > 坎 > 兑 > 巽 > 离 > 坤 > 震 ----
  let upper = ''
  let why = ''
  if (RE_BOUND.test(t)) { upper = '艮'; why = '碰到边界/隐私' }
  else if (RE_RULE.test(t)) { upper = '乾'; why = '讲的是规矩' }
  else if (RE_TECH.test(t)) { upper = '坎'; why = '技术细节' }
  else if (RE_PERSON.test(t)) { upper = '兑'; why = '讲某个人' }
  else if (RE_PREFER.test(t)) { upper = '巽'; why = '讲喜好' }
  else if (RE_FEEL.test(t)) { upper = '离'; why = '讲心情' }
  else if (RE_KNOW.test(t)) { upper = '坤'; why = '知识事实' }
  else if (RE_EVENT.test(t)) { upper = '震'; why = '某天的事' }
  else { upper = '坤'; why = '归到事实' }

  // ---- 下卦，按优先级：乾 > 坎 > 艮 > 震 > 巽 > 兑 > 离 > 坤 ----
  let lower = ''
  let why2 = ''
  if (RE_RULE.test(t)) { lower = '乾'; why2 = '要一直生效' }
  else if (RE_NOW.test(t)) { lower = '震'; why2 = '马上就要用' }
  else if (RE_TECH.test(t)) { lower = '坎'; why2 = '下次别踩' }
  else if (RE_EXPIRE.test(t)) { lower = '艮'; why2 = '已经作废' }
  else if (RE_PREFER.test(t)) { lower = '巽'; why2 = '影响语气口味' }
  else if (RE_TO_PERSON.test(t)) { lower = '兑'; why2 = '只对某人有用' }
  else if (RE_TALK.test(t)) { lower = '离'; why2 = '可以主动聊' }
  else { lower = '坤'; why2 = '平时备查' }

  return { upper, lower, reason: why + ' / ' + why2 }
}

/** 一条记忆盖完密级之后，要不要再标个卦 */
export function markGua(item, enabled) {
  if (!enabled) return item
  const g = gua(item?.text)
  return { ...item, gua: g.upper + g.lower, guaUpper: g.upper, guaLower: g.lower }
}
