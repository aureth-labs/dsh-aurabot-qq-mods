import { text } from './store.mjs'

export const confirmedReceipt = r => Boolean(r && r.message_id !== undefined && r.message_id !== null && String(r.message_id) && !/^(sim-|queued-)/.test(String(r.message_id)) && !r.failed && !r.errors?.length && r.ok !== false)

// Resolve only persisted delivery receipts in this persona and chat. Album order is not send order.
export function photoFollowup({ photos, profileId, ownerId, personaId, chatId, replyIds = [], facts, now }) {
  const rows = []
  for (const p of photos) {
    if (p.ownerId !== ownerId || p.profileId !== profileId || p.archived || p.allowedForChat === false || (p.chatId && p.chatId !== chatId)) continue
    for (const d of p.deliveries || []) {
      if (d.status !== 'sent' || d.chatId !== chatId || (d.personaId && d.personaId !== personaId)) continue
      const sentAt = Number(d.sentAt || d.at)
      if (!Number.isFinite(sentAt) || sentAt > now) continue
      rows.push({ p, d, sentAt })
    }
  }
  rows.sort((a,b) => b.sentAt - a.sentAt)
  const describe = ({p,d,sentAt}) => {
    const f = facts(p), o = f.observedFacts
    return { photoId:p.id, messageId:d.messageId || null, sentAt:new Date(sentAt).toISOString(),
      ageMinutes:Math.floor((now-sentAt)/60000), source:p.source, subjectIsRole:f.subjectIsRole,
      identityContext:f.identityContext, grounding:f.grounding, observationSource:f.observationSource,
      description:text(f.description,650), relations:(o?.relations || []).slice(0,5),
      uncertainties:(o?.uncertainties || []).slice(0,5), requestDifferences:(o?.requestDifferences || []).slice(0,4),
      userAnnotation:text(f.userAnnotation,300), currentActivityNotConfirmed:true }
  }
  // Iterate newest first; Map's last-wins behaviour must not select an older resend.
  const unique = list => {const seen=new Set();return list.filter(r=>!seen.has(r.p.id)&&seen.add(r.p.id))}
  const ids = [...new Set(replyIds.map(String))].slice(-8)
  const referenced = unique(rows.filter(r=>r.d.messageId && ids.includes(String(r.d.messageId))))
  return { referenceResolution:ids.length ? (referenced.length ? 'matched-delivery' : 'not-in-this-album') : 'no-explicit-reply',
    referencedPhotos:referenced.map(describe),
    recentSentPhotos:unique(rows.filter(r=>now-r.sentAt<=86400000)).slice(0,3).map(describe) }
}

export const FOLLOWUP_RULE = '用户追问图片内容时，先结合引用消息和上下文确定所指图片：referencedPhotos 是本聊天已确认发出的引用图片；没有明确引用时，recentSentPhotos 按实际发送时间排列（旧图重发也算），仅在“这张、刚才发的”等指代明确时优先使用，不按相册创建顺序猜。若明确引用未匹配，不把最近照片冒充被引用图；多张无法区分时简短澄清。先用实际 description/relations 回答画面中的活动、物品或穿搭，再自然接话，不能以人格职业、当前时间、旧剧情或原生成需求替代画面事实。未确定的饮品、动物名字等不猜；照片拍摄状态不自动等于此刻正在做的事。subjectIsRole 只表示应用绑定，不能把普通画作或未知上传主体当自己。缺少可靠画面事实时如实说明，不能用请求补造。单纯询问图片不是索图，不重新生成或重发；普通“你在干嘛”没有图片指代时正常聊天。已在当前对话或可信近期记录中明确回答的信息应接续使用，用户更正优先；不要重复询问已答问题，确有冲突或缺失时只确认缺少的部分。'
