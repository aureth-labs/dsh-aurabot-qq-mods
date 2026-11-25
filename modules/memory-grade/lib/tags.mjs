/**
 * 记忆标签表（2026-11-20 定）
 *
 * 两类分开：来源（从哪来）和类型（是什么）。
 * 写入时只从这里挑，别让模型自己编。
 */

/** 来源：从哪来 */
export const SOURCE_TAGS = ['群聊', '私聊', 'B站', '抖音', '贴吧', '小黑盒', '热榜', '空间日记', '网页']

/** 类型：是什么 */
export const TYPE_TAGS = ['经历', '知识', '事实', '约定', '规矩', '日常', '长期印象', '记忆整理']

/** 两个不能动的钩子标签：插件看到它们会判密级 */
export const HOOK_FAMILY = '家人'   // → secret
export const HOOK_KNOWLEDGE = '知识' // → public

/** 旧的散标签 → 新表 */
export const MERGE_MAP = {
  // 来源
  抖音: '抖音',
  B站: 'B站',
  贴吧: '贴吧',
  小黑盒: '小黑盒',
  热榜: '热榜',
  巡游: '热榜',
  空间日记: '空间日记',
  // 类型
  家人代办: '规矩',
  硬规矩: '规矩',
  规则: '规矩',
  流程: '规矩',
  技术: '事实',
  技术事实: '事实',
  偏好: '事实',
  称呼: '事实',
  生日: '事实',
  事实: '事实',
  画画: '经历',
  表情: '经历',
  // 其他都并进记忆整理（都是临时冒出来的）
  记忆系统: '记忆整理',
  播种计划: '记忆整理',
  GitHub: '记忆整理',
  统计: '记忆整理',
  进度: '记忆整理',
  模型输出: '记忆整理',
  JSON解析: '记忆整理',
  故障: '记忆整理',
  兜底: '记忆整理',
  CosyVoice: '记忆整理',
  白米饭: '日常',
}

/** 直接删掉的（危险的或没意义的） */
export const DROP_TAGS = ['机密']

/**
 * 规整一组标签：并掉散标签、去掉危险的、去重、限制个数。
 * @param {string[]} tags
 * @param {string} [src] 来源（chat/bili/douyin...），有就顺手加个来源标签
 * @param {object} [opts] { chatId } —— src 是 chat 时用它分私聊/群聊
 * @returns {string[]}
 */
export function normalizeTags(tags, src, opts = {}) {
  const out = new Set()
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw || '').trim()
    if (!t) continue
    if (DROP_TAGS.includes(t)) continue
    const mapped = MERGE_MAP[t] || t
    // 只收表里的，表外的一律不要
    if (SOURCE_TAGS.includes(mapped) || TYPE_TAGS.includes(mapped) || mapped === HOOK_FAMILY) {
      out.add(mapped)
    }
  }
  // 来源标签：从 src 推
  // chat 要再分一层——私聊和群聊是两回事，不能一律算「群聊」
  const srcTagMap = {
    bili: 'B站',
    douyin: '抖音',
    tieba: '贴吧',
    tophub: '热榜',
    diary: '空间日记',
    heybox: '小黑盒',
    // knowledge 是类型不是来源，这里不给来源标签
    // event / tool / panel 也没固定来源，按调用方给的 tags 走
  }
  let srcTag = srcTagMap[String(src || '')]
  if (String(src || '') === 'chat') {
    // 私聊还是群聊，看 chatId（调用方会传进来）
    srcTag = String(opts?.chatId || '').startsWith('group:') ? '群聊' : '私聊'
  }
  if (srcTag && !out.has(srcTag)) out.add(srcTag)
  // 一个类型都没给，补个默认
  const hasType = [...out].some((t) => TYPE_TAGS.includes(t))
  if (!hasType) out.add('经历')
  return [...out].slice(0, 5)
}
