import { AROUSAL_TENDENCIES, estimateTokens, arousalValue } from './policy.mjs'

/** 五档名，顺序固定；分界来自 config.arousal.bands（四个递增值）。 */
export const AROUSAL_TIERS = Object.freeze(['很低', '较低', '中等', '较高', '很高'])

/** 数值落档：返回 0..4 的索引。 */
export function tierIndex(config, value) {
  const bands = config.arousal?.bands
  const b = Array.isArray(bands) && bands.length === 4 ? bands : [15, 35, 55, 75]
  if (value < b[0]) return 0
  if (value < b[1]) return 1
  if (value < b[2]) return 2
  if (value < b[3]) return 3
  return 4
}

/**
 * 解析情欲段落：正文（去掉【标题】行与档位列表）与五档句子分开放。
 * 段落里以 "- 平静：…" 这样的一行一条，注入时只取当前档那一条。
 */
export function parseArousalTemplate(template) {
  const out = { body: '', tiers: {}, ranges: [], title: '' }
  if (!template || typeof template !== 'string') return out
  const body = []
  for (const line of template.split(/\r?\n/)) {
    const titled = line.match(/^\s*【([^】]+)】\s*$/)
    if (titled) { if (!out.title) out.title = titled[1]; continue }
    const tier = line.match(/^\s*(?:[-*·]\s*)?情欲值?(很低|较低|中等|较高|很高)\s*[：:]\s*(.+)$/)
    if (tier) { out.tiers[tier[1]] = tier[2].trim(); continue }
    const range = line.match(/^\s*(?:[-*·]\s*)?情欲值?\s*(\d{1,3})\s*[–—~\u81f3-]\s*(\d{1,3})\s*[：:]\s*(.+)$/)
    if (range) { out.ranges.push({ from: Number(range[1]), to: Number(range[2]), text: range[3].trim() }); continue }
    body.push(line)
  }
  out.body = body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return out
}


/** 按当前值取区间文案（模板用「情欲值 0-14：」这类行时生效）。 */
export function rangeText(parsed, value) {
  const r = parsed.ranges.find(x => Math.floor(value) >= x.from && Math.floor(value) <= x.to)
  return r ? r.text : ''
}
/** 兼容旧调用：返回 {key,name,index,text,label}。 */
export function bandKey(config, value) {
  const index = tierIndex(config, value)
  const name = AROUSAL_TIERS[index]
  const legacy = ['low', 'middle', 'high'][Math.min(2, Math.floor((index * 3) / 5))]
  return { index, name, legacy }
}

export function arousalBand(config, value) {
  const { index, name, legacy } = bandKey(config, value)
  const parsed = parseArousalTemplate(config.arousal?.template)
  const fromTemplate = rangeText(parsed, value) || parsed.tiers[name]
  const fallback = (config.arousal?.tendencies?.[legacy] ?? AROUSAL_TENDENCIES[legacy] ?? '').trim()
  const text = (fromTemplate || fallback).trim()
  return { key: legacy, index, name, text, label: text || fallback }
}

export function activeArousalBand(config, state, now = Date.now()) {
  const value = arousalValue(state, config, now)
  return { ...arousalBand(config, value), value }
}

/** 组装情欲整段：正文 + 当前情欲值（档位） + 性癖喜好，合成一段连续文字。 */
export function templateNotice(template) {
  const ranges=parseArousalTemplate(template).ranges
  if(!ranges.length)return ''
  if(ranges.some(r=>r.from>r.to||r.to>100))return '区间须在 0 到 100 之间且起点不高于终点'
  for(let n=0;n<=100;n++){
    const matches=ranges.filter(r=>n>=r.from&&n<=r.to).length
    if(matches!==1)return '情欲值 '+n+(matches?' 同时落入多个区间':' 缺少对应区间')
  }
  return ''
}
function arousalParagraph(c, s, now) {
  const parsed = parseArousalTemplate(c.arousal?.template)
  const lines = []
  if (parsed.body) lines.push(parsed.body)
  else for (const k of ["optionalText", "explicitness", "initiative"]) if (c[k]) lines.push(String(c[k]).trim())
  if (c.arousal?.enabled) {
    const band = activeArousalBand(c, s, now)
    if (band.text) lines.push(band.text.replace(/[。\s]+$/, "") + "。")
  }
  if (c.kinks?.length && !/性癖喜好/.test(parsed.body)) lines.push("性癖喜好：" + c.kinks.join("、") + "。")
  return lines.filter(Boolean).join("\n")
}

export const OWNER_AFFECTION_RULE='本模块的恋爱推进、调情和情欲表达仅面向主人。其他人不成为新增恋爱或亲密对象。预设中已有的固定伴侣按原有背景处理，不能据此拓展新的攻略对象。'
export const OUTSIDE_AFFECTION_RULE='群聊与其他私聊保持一般社交，不对其他人发展恋爱、调情或情欲互动。本模块的关系与亲密设定只适用于主人。'

export function renderContext(row, { scope = 'owner-private', globalOptional = false, now = Date.now(), storyStatus = null } = {}) {
  if (!row || !['manual', 'auto'].includes(row.config.mode)) return { text: '', reason: '当前模式不注入' }
  const c = row.config, s = row.state
  if (scope !== 'owner-private') {
    if (!['public', 'other-private'].includes(scope)) return { text: '', reason: '未知场景不注入' }
    // Only the author-controlled scene template crosses this boundary. No private
    // state, names, score, optional paragraph, boundaries or facts are projected.
    const template = c.prompts[scope === 'public' ? 'outside' : 'notOwner'].replace(/\{[^{}]+\}/g, '')
    const text = '【当前交流场景】\n'+template+'\n不从其他私聊读取或转述关系、名分与共同经历。\n'+OUTSIDE_AFFECTION_RULE
    const tokens = estimateTokens(text)
    if(tokens <= c.contextTokens)return { text, estimatedTokens: tokens, optionalIncluded: false, scope }
    const boundary = '不转述其他私聊的经历。'+OUTSIDE_AFFECTION_RULE
    return { text:boundary, estimatedTokens:estimateTokens(boundary), optionalIncluded:false, scope, reason:'场景模板超额，仅保留公开范围规则' }
  }
  const p = c.stageProfiles[s.stage - 1], vars = { stageMeaning: p.meaning, stageTendencies: p.daily, confirmedContext: s.status === '未定义' ? '未确认额外关系名分，不编造共同过去。' : '已有来源确认的关系：' + s.status }
  const fill = x => x.replace(/\{([^{}]+)\}/g, (_, k) => vars[k] ?? '')
  const optional = globalOptional && c.optionalEnabled && c.arousal.enabled && s.stage >= c.stageGate
  const parts = ['【关系模块当轮状态；配置不是经历，不存成玩家事实】',fill(c.prompts.relation)]
  if (s.historyBefore) parts.push('这段关系已重新开始。' + new Date(s.historyBefore).toISOString() + '之前的聊天和共同经历只属于历史关系；可记得往事，但不得用旧名分、旧承诺或旧阶段恢复当前恋爱状态。当前关系以本段为准。')
  const core=[...parts]
  core.push(OWNER_AFFECTION_RULE)
  if(storyStatus)parts.push('仅限双方角色剧情的称谓：'+storyStatus+'。此称谓不改变现实关系或承诺。')
  if(c.romanceBackground)parts.push('恋爱背景：\n'+c.romanceBackground)
  let extra=''
  if (optional) {
    const paragraph = arousalParagraph(c, s, now)
    if (paragraph) {extra=paragraph;parts.push(paragraph)}
  } else parts.push(fill(globalOptional && c.optionalEnabled ? c.prompts.notYet : c.prompts.noSex))
  parts.push('原人格卡保持原文；当前状态不授予真实工具或平台权限。',OWNER_AFFECTION_RULE)
  const text = parts.filter(Boolean).join('\n\n'), tokens = estimateTokens(text)
  if (tokens > c.contextTokens) {
    const coreText=core.join('\n\n')
    const kept=parts.filter(part=>part!==extra).join('\n\n')
    for(const candidate of [kept,coreText]){
      const size=estimateTokens(candidate)
      if(size<=c.contextTokens)return {text:candidate,estimatedTokens:size,optionalIncluded:false,reason:'附加预算不足，已省略可选文字'}
    }
    const minimum=['当前相处阶段 '+s.stage+'/5。',OWNER_AFFECTION_RULE]
    if(s.historyBefore)minimum.push('已重新开始，旧名分、承诺及阶段不再生效。')
    if(!optional)minimum.push('本轮保持日常相处范围。')
    const boundary=minimum.join('\n')
    return {text:boundary,estimatedTokens:estimateTokens(boundary),optionalIncluded:false,reason:'阶段正文超额，仅保留阶段和固定边界'}
  }
  return { text, estimatedTokens: tokens, optionalIncluded: !!extra, source: { persona: row.persona, epoch: s.epoch, revision: s.revision, configRevision: row.configRevision } }
}

/** Request-only projection: do not append to session.surface or alter author/system text. */
export function projectMessages(session, messages, { createUserMessage }, runtime) {
  if (!Array.isArray(messages)) throw Error('DSH请求消息格式不受支持')
  // Only tagged messages emitted by this request adapter are withdrawn. User text is never searched or stripped.
  const base = messages.filter(m => !(m.source?.kind === 'character-relation' && m.source?.form === 'request-context'))
  let rendered
  try { rendered = runtime?.contextForSession(session) } catch (error) { if (runtime) runtime.lastIssue = '关系附加段暂不可用：' + String(error.message).slice(0, 160); return base.length === messages.length ? messages : base }
  if (!rendered?.text) return base.length === messages.length ? messages : base
  const message = createUserMessage({ content: [{ type: 'text', text: rendered.text }], source: { kind: 'character-relation', form: 'request-context' } })
  const projected=[...base,message]
  if(rendered.diagnosticScope){
    const labels={system:'系统',developer:'开发者',assistant:'角色',tool:'工具',user:'用户'}
    const groups=[]
    for(const item of projected){
      const kind=item?.source?.kind
      const label=kind==='character-relation'?'恋爱附加段':kind==='persona-memory'?'记忆':labels[item?.role]||'其他'
      if(groups.at(-1)?.label===label)groups.at(-1).count++
      else groups.push({label,count:1})
    }
    runtime.lastProjection={...rendered.diagnosticScope,at:runtime.now(),messages:projected.length,
      groups:groups.slice(-16),omittedGroups:Math.max(0,groups.length-16),reason:rendered.reason||'',optional:rendered.optionalIncluded}
  }
  return projected
}
