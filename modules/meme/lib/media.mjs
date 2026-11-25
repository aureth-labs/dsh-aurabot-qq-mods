import { UserError } from './errors.mjs';
const decodeCQ = s => s.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
export function messageSegments(msg) {
  const source = msg.raw?.message;
  if (Array.isArray(source)) return source;
  if (typeof source !== 'string') return null;
  const result = []; let end = 0;
  for (const m of source.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    if (m.index > end) result.push({type:'text',data:{text:decodeCQ(source.slice(end,m.index))}});
    const data = Object.fromEntries(m[2].slice(1).split(',').filter(Boolean).map(field=>{const cut=field.indexOf('=');return [field.slice(0,cut),decodeCQ(field.slice(cut+1))];}));
    result.push({type:m[1],data}); end = m.index + m[0].length;
  }
  if (end < source.length) result.push({type:'text',data:{text:decodeCQ(source.slice(end))}});
  return result;
}
export function rawText(msg) {
  const segments = messageSegments(msg);
  if (Array.isArray(segments)) return segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
  return String(msg.text || '').replace(/\[(?:图片|表情包)\]/g, '').replace(/@\s*\d+/g, '').trim();
}
export async function collectImages(api, msg, params, cache, allowAvatar = true) {
  if (!params.maxImages) return [];
  const { fetchImage } = api.lib('core/net.js');
  async function download(url, name) {
    if (!/^https?:\/\//i.test(url)) throw new UserError('只接受 QQ 图片链接，不读取消息里的本机文件路径');
    const data = await fetchImage(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 12000, allowLocal: false });
    return { name, data: Buffer.from(data).toString('base64') };
  }
  async function avatar(id, name) {
    if (!/^\d{5,12}$/.test(id)) throw new UserError('QQ 号格式不正确');
    const old = cache.get(id);
    if (old && Date.now() - old.time < 1200000) return { ...old.image, name };
    const image = await download(`https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`, name);
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(id, { image, time: Date.now() });
    return image;
  }
  const source = messageSegments(msg) || [];
  const segments = source.filter(s => ['image','mface'].includes(s.type));
  if (!segments.length) segments.push(...(msg.images || []), ...(msg.stickers || []));
  let quoted, quotedImages = [];
  const replyId = msg.replyId || source.find(s=>s.type==='reply')?.data?.id;
  if (replyId && segments.length < params.maxImages) {
    quoted = await api.onebot('get_msg', { message_id: replyId });
    quotedImages = (messageSegments({raw:quoted}) || []).filter(s => ['image', 'mface'].includes(s.type));
    segments.push(...quotedImages);
  }
  const targets = source.filter(s => s.type === 'at' && /^\d+$/.test(String(s.data?.qq)))
    // QQ replies may add @quoted-author automatically; the quoted picture is the input.
    .filter(s => !quotedImages.length || String(s.data.qq) !== String(quoted?.sender?.user_id))
    .map(s => ({ id: String(s.data.qq), name: s.data.name || String(s.data.qq) }));
  // A leading @bot is an address, not an avatar argument when there is an actual target/image.
  if (targets.length && targets[0].id === String(msg.raw?.self_id) && (targets.length > 1 || segments.length)) targets.shift();
  const images = [];
  for (const segment of segments) {
    if (images.length >= params.maxImages) break;
    let url = segment.data?.url;
    if (!url && segment.data?.file) { const info = await api.onebot('get_image', { file: segment.data.file }); url = info?.url; }
    if (!url) throw new UserError('无法取得这张 QQ 图片，请重新发送图片');
    images.push(await download(url, msg.nickname || '图片'));
  }
  // Actual attachments take precedence; explicit @ targets only fill remaining slots.
  for (const target of targets) {
    if (images.length >= params.maxImages) break;
    images.push(await avatar(target.id, target.name));
  }
  if (!images.length && quoted?.sender?.user_id && allowAvatar) images.push(await avatar(String(quoted.sender.user_id), quoted.sender.nickname || '引用者'));
  if (images.length < params.minImages && allowAvatar) images.unshift(await avatar(String(msg.userId), msg.nickname || '我'));
  if (images.length < params.minImages && allowAvatar) {
    const bot = String(msg.raw?.self_id || (await api.onebot('get_login_info', {}))?.user_id || '');
    const fallback = await avatar(bot, '机器人');
    while (images.length < params.minImages) images.push(fallback);
  }
  if (images.length < params.minImages) throw new UserError(`需要 ${params.minImages}–${params.maxImages} 张图片，请附图、引用图片或 @目标`);
  return images;
}
