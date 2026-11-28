import { createHash } from 'node:crypto'
import { LIFE_IDENTITIES } from './life-identities.mjs'
import { publicUrl, readPublicPage } from './public-reading/public-web.mjs'
import { parseFeed, stripHtml } from './public-reading/feed.mjs'
import { confirmedReceipt } from './followup.mjs'

const minute = 60000, day = 1440 * minute
export const WEB_DEFAULTS = {
  reading:false, webMode:'search', topics:'', webFeeds:'', sharePrivate:false, group:false, groupName:'',
  webMinutes:120, webMax:5, webDaily:3, webSearchStart:'', webSearchEnd:'',
}
const parts = raw => [...new Set(String(raw).split(/[、，,;；\r\n]+/).map(x => x.trim()).filter(Boolean))]
export function webSettings(raw) {
  const c = Object.fromEntries(Object.entries(WEB_DEFAULTS).map(([k,val]) => [k,raw[k] ?? val]))
  if (!['reading','sharePrivate','group'].every(k => typeof c[k] === 'boolean') || !['search','feeds','both'].includes(c.webMode)) throw Error('上网选项无效')
  for (const [k,min,max] of [['webMinutes',15,1440],['webMax',0,30],['webDaily',0,24]]) {
    if (!Number.isInteger(c[k]) || c[k] < min || c[k] > max) throw Error('上网间隔或每日上限超出范围')
  }
  for (const key of ['webSearchStart','webSearchEnd']) if (c[key] !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(c[key])) throw Error('搜索时段请填写 HH:mm')
  if (!!c.webSearchStart !== !!c.webSearchEnd) throw Error('请同时填写搜索开始和结束时间')
  if (typeof c.webFeeds !== 'string' || c.webFeeds.length > 4000 || typeof c.topics !== 'string' || c.topics.length > 600 || typeof c.groupName !== 'string' || c.groupName.length > 360) throw Error('上网资料过长或格式有误')
  const feeds = [...new Set(c.webFeeds.split(/\r?\n/).map(v=>v.trim()).filter(Boolean))]
  if (feeds.length > 16 || parts(c.topics).length > 16 || parts(c.groupName).length > 16) throw Error('每种上网资料最多 16 项')
  try { c.webFeeds = feeds.map(v=>publicUrl(v).href).join('\n') } catch { throw Error('订阅需要公开的 HTTP(S) 地址') }
  if (parts(c.groupName).some(x=>!/^\d{5,12}$/.test(x))) throw Error('允许分享的群请填写 QQ 群号')
  if (parts(c.topics).some(x=>x.length>60 || /@|https?:|\d{5,}/i.test(x))) throw Error('公开搜索话题请填写简短关键词，排除账号和链接')
  return c
}

// Chats and player-authored interests may contain names, locations or quotations. Only fixed public topics can leave those sources.
const subjects=[
  [/插画|速写|绘画|配色|水彩|画展/,'插画与绘画技巧'],[/书店|阅读|书市|小说|书展/,'书籍与出版'],[/摄影|相机|拍照/,'摄影技巧'],
  [/游戏|电竞|联机/,'电子游戏资讯'],[/陶艺|手工|编织/,'手工艺'],[/咖啡|拉花/,'咖啡与拉花'],[/烘焙|料理|甜品|菜谱/,'烘焙与料理'],
  [/植物|绿植|插花|园艺/,'花艺与园艺'],[/音乐|乐器|乐谱/,'音乐与演出'],[/运动|散步|网球|骑行/,'户外运动'],[/漫画|动画|番剧/,'动漫资讯'],
]
const builtIn = new Set(LIFE_IDENTITIES.flatMap(x=>x.patch.interests || []))
const publicTopics=value=>subjects.filter(([pattern])=>pattern.test(value)).map(([,topic])=>topic)
const groups=c=>parts(c.groupName)
const hash=value=>createHash('sha256').update(value).digest('hex')
const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim()
const inWindow=(time,start,end)=>start && (start===end || (start<end?time>=start && time<end:time>=start || time<end))
const safeLink=(value,base)=>{try{return publicUrl(base?new URL(value,base).href:value).href}catch{return ''}}
const messages={
  waiting:'等待已确认的搜索时段或订阅地址', 'no-topic':'等待可公开的阅读话题', 'no-provider':'当前没有可用的 DSH 搜索服务',
  unavailable:'这次未能读取公开资料', empty:'没有找到新鲜且有正文的条目', reading:'正在读取', read:'已读到正文',
}
function extract(page){
  let s=String(page.content||'')
  if (page.html) {
    s=s.replace(/<(script|style|head|nav|footer|header|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    s=s.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2] ?? s
    if(!/<(?:p|article|main|div|section|body)\b/i.test(s) && s.length<80)return ''
  } else if(page.type && !/^text\/plain\b/i.test(page.type)) return ''
  const body=clean(stripHtml(s,480))
  return body.length>=40?body:''
}

export function createLifeWeb(api,{runtime,owner,current,now,view,sources,readPage=readPublicPage}){
  let stopped=false, pending=null
  const same=(a,b)=>b?.state && a.personaId===b.personaId && a.card.revision===b.card.revision && a.revision===b.revision && a.epoch===b.epoch && a.state.scopeRevision===b.state.scopeRevision
  const onDuty=v=>!stopped && api.config().enabled!==false && !api.config().dryRun && v?.config.reading && v.state?.phase==='free' && v.state.selfCare?.stage!=='in-progress' && !v.state.plannedActivity && v.state.kind!=='conversation' && v.state.presence!=='together' && !v.state.activityId && (v.state.availableMinutes ?? 15)>=5
  const valid=(a,v)=>a.card===v.card?.revision && a.epoch===v.epoch && (!a.ref || sources.valid(a.ref,v.personaId,owner()))
  function choices(v){
    const c=v.config, explicit=parts(c.topics)
    if(explicit.length)return explicit.map(topic=>({topic,audience:'public'}))
    const own=c.interests.flatMap(x=>builtIn.has(x)?[x]:publicTopics(x))
    const other=LIFE_IDENTITIES.find(x=>x.id===c.presetSelection?.career)?.patch.interests || []
    const themes=[...new Set(own.length?own:other)].map(topic=>({topic,audience:'public'}))
    if(!sources.ready())return themes
    const recent=[...sources.messages(v.personaId,owner()).map(x=>({...x,audience:'private:'+owner()})),
      ...sources.groupMessages(v.personaId).filter(x=>x.ref.role==='user' && c.group && api.config().ext?.['smart-search']?.ownerOnly!==true && groups(c).includes(x.ref.chatId?.slice(6))).map(x=>({...x,audience:x.ref.chatId}))]
    for(const x of recent.reverse()){
      if(x.ref.at>now() || now()-x.ref.at>2*day)continue
      const topic=publicTopics(x.text)[0]
      if(topic && !themes.some(t=>t.topic===topic && t.audience===x.audience))themes.push({topic,audience:x.audience,ref:x.ref})
      if(themes.length>=16)break
    }
    return themes
  }
  function snapshot(v,row){
    const log=row.web||{}, items=(log.items||[]).filter(a=>valid(a,v)).map(({title,url,body,at,topic,channel})=>({title,url,excerpt:body,at,topic,channel}))
    const waiting=v.config.reading && !v.config.webFeeds && !v.config.webSearchStart
    return {status:messages[log.status]||(waiting?messages.waiting:''),attempts:log.day===v.localDay?log.attempts:0,lastAt:log.lastAt||0,items:items.slice(-12).reverse(),
      deliveries:(log.deliveries||[]).filter(d=>items.some(a=>hash(a.url)===d.key)).slice(-15).map(({at,to,state,receipt})=>({at,to,state,receipt})).reverse()}
  }
  async function selectArticle(v,log,channel,topic,signal,still){
    const seen=new Set((log.items||[]).filter(a=>valid(a,v)).map(a=>a.url))
    let rows=[]
    if(channel==='feeds'){
      const feeds=v.config.webFeeds.split('\n').filter(Boolean)
      const feed=await readPage(feeds[(log.feedRounds||0)%feeds.length],signal)
      rows=parseFeed(feed.content,{source:feed.url}).items.filter(x=>!x.at || !(now()-x.at>7*day || x.at-now()>day))
        .map(x=>({title:x.title,url:safeLink(x.link,feed.url),summary:x.summary}))
      const matches=rows.filter(x=>(x.title+' '+x.summary).includes(topic.topic))
      if(topic.topic && topic.audience!=='public')rows=matches
      else if(matches.length) rows=matches
    } else {
      const marketConfig=api.config().ext?.['smart-search']
      const market=api.use?.('smart-search')
      if(marketConfig || market){
        if(!market?.status)throw Error('no-provider')
        const status=await market.status()
        if(!status?.enabled || !status.providers?.some(x=>x.id==='dsh'&&x.enabled&&x.ready) || status.active>=3)throw Error('no-provider')
      }
      const web=api.dsh?.get?.('web')
      web?.selectSearchProvider?.()
      if(typeof web?.search!=='function' || (await web.searchReady?.())===false)throw Error('no-provider')
      if(!still())return null
      const result=await web.search({query:topic.topic,maxResults:5},signal)
      rows=(Array.isArray(result?.sources)?result.sources:[]).slice(0,5).filter(x=>x&&typeof x==='object').filter(x=>{
        const at=Date.parse(x.publishedAt);return !Number.isFinite(at) || (now()-at<30*day && at-now()<day)
      })
    }
    let requests=0
    for(const r of rows.slice(0,12)){
      if(!still())return null
      const url=safeLink(r.url)
      if(!url || seen.has(url) || !clean(r.title))continue
      if(++requests>2)break
      let page
      try{page=await readPage(url,signal)}catch{signal.throwIfAborted();continue}
      const final=safeLink(page.url),body=extract(page)
      if(!final || seen.has(final) || !body)continue
      return {...topic,url:final,body,title:clean(r.title).slice(0,120),channel,at:now(),epoch:v.epoch,card:v.card.revision}
    }
    return null
  }
  function groupAllowed(to,v,log){
    const cfg=api.config(), gid=to.slice(6)
    if(!v.config.group || !groups(v.config).includes(gid) || !cfg.allow?.groups?.map(String).includes(gid) || typeof api.core?.mutes?.muted!=='function' || api.core.mutes.muted(to))return false
    const {policyFor,inQuietHours}=api.lib('chat/group-policy.js'), p=policyFor(cfg.group,cfg.group?.overrides,gid)
    const recent=(log.deliveries||[]).filter(d=>d.to===to && now()-d.at<3600000)
    return p.interjectChance>0 && !inQuietHours(Number(v.state.localTime.slice(-5,-3)),p.quietHours)
      && recent.length<p.maxPerHour && !recent.some(d=>now()-d.at<p.cooldownSec*1000)
  }
  function targets(article,v,log){
    const c=v.config,priv='private:'+owner(),out=[]
    if(c.sharePrivate && api.proactive?.available && (api.config().outboundPolicy?.tier ?? api.config().ext?.outboundPolicy?.tier)==='broker')out.push(priv)
    if(c.group)for(const gid of groups(c))if(groupAllowed('group:'+gid,v,log))out.push('group:'+gid)
    return out.filter(t=>article.audience==='public'||article.audience===t)
  }
  function reconcile(v,log){
    const updated=[]
    for(const d of log.deliveries||[]){
      if(d.state==='sent' || now()-d.at>day)continue
      if(['host-confirmed','offered-to-native-turn','uncertain','unconfirmed','queued','pending','sending'].includes(d.state)){
        const article=log.items?.find(a=>hash(a.url)===d.key && valid(a,v))
        const ack=article && sources.readingReceipt?.(v.personaId,d.to,article.url,d.at,Math.min(now(),d.at+30*minute))
        if(ack){updated.push({key:d.key,to:d.to,state:'sent',receipt:ack});continue}
      }
      if(!d.receipt || !d.to.startsWith('private:') || !['pending','sending','uncertain'].includes(d.state) || typeof api.proactive?.statusOf!=='function')continue
      const ack=api.proactive.statusOf(d.receipt)
      if(!ack || ack.deliveryId!==d.receipt || (ack.to && ack.to!==d.to))continue
      const state=ack.state==='sent'?'host-confirmed':ack.state
      if(['pending','sending','host-confirmed','failed','expired','dropped','uncertain'].includes(state) && state!==d.state)updated.push({key:d.key,to:d.to,state,receipt:d.receipt})
    }
    if(updated.length)runtime.change(owner(),v.personaId,r=>{
      for(const update of updated)Object.assign(r.web.deliveries.find(d=>d.key===update.key && d.to===update.to),{state:update.state,receipt:update.receipt})
    })
  }
  async function dispatch(v,article,still){
    const uid=owner(), id=v.personaId, key=hash(article.url)
    for(const to of targets(article,v,runtime.read(uid,id).web||{})){
      if(!still())return
      const log=runtime.read(uid,id).web
      if(log.day!==v.localDay || (log.shareCount||0)>=v.config.webMax || !targets(article,v,log).includes(to) || (log.deliveries||[]).some(d=>d.key===key && d.to===to))continue
      runtime.change(uid,id,r=>{
        r.web.shareCount=(r.web.shareCount||0)+1
        r.web.deliveries=[...(r.web.deliveries||[]).slice(-79),{key,to,at:now(),state:'uncertain'}]
      })
      const line='刚读到《'+article.title+'》。\n'+article.url
      let state='uncertain',receipt=''
      try{
        if(to.startsWith('group:')){
          const ack=await api.core.hub.sendText(to,line,undefined,undefined,undefined,{proactive:true,proactiveCause:'life-reading',queueKind:'proactive',isCurrent:()=>still() && groupAllowedForInflight()})
          if(confirmedReceipt(ack)){state='sent';receipt=String(ack.message_id)}
          else if(ack?.queued)state='queued'
          else if(!ack)state='unconfirmed'
        } else {
          const ack=await api.proactive.submit({to,itemId:'read-'+key,channel:'qq',text:line,cause:{kind:'background'}})
          if(ack?.deliveryId)receipt=String(ack.deliveryId)
          state=ack?.state==='sent'?'host-confirmed':(['pending','dropped','failed','unsupported','expired','uncertain','sending'].includes(ack?.state)?ack.state:'uncertain')
        }
      }catch{}
      function groupAllowedForInflight(){
        const live=runtime.read(uid,id).web
        return !!live && groupAllowed(to,v,{...live,deliveries:(live.deliveries||[]).filter(d=>d.key!==key||d.to!==to)})
      }
      const done=runtime.read(uid,id).web?.deliveries?.find(d=>d.key===key&&d.to===to)
      if(done)runtime.change(uid,id,r=>Object.assign(r.web.deliveries.find(d=>d.key===key&&d.to===to),{state,receipt}))
    }
  }
  async function tick(initial){
    if(pending || stopped)return
    const v=initial||view()
    if(!onDuty(v))return
    const uid=owner(),id=current(),at=now(),c=v.config,log=runtime.read(uid,id).web||{}
    reconcile(v,log)
    if(!c.webDaily || (log.lastAt!=null && at-log.lastAt<c.webMinutes*minute) || (log.day===v.localDay && log.attempts>=c.webDaily))return
    const feed=c.webMode!=='search' && !!c.webFeeds
    const recentSearches=(log.searchTimes||[]).filter(t=>at-t<3600000)
    const hourly=api.config().ext?.['smart-search']?.hourlyLimit??30
    const search=c.webMode!=='feeds' && recentSearches.length<hourly && inWindow(v.state.localTime.slice(-5),c.webSearchStart,c.webSearchEnd)
    if(!feed && !search)return
    const selection=choices(v), seq=log.sequence||0
    const channel=feed && (!search || seq%2===0 || !selection.length)?'feeds':'search'
    const rounds=channel==='feeds'?log.feedRounds||0:log.searchRounds||0
    const topic=selection.length?selection[rounds%selection.length]:{topic:'',audience:'public'}
    if(channel==='search' && !topic.topic)return
    const controller=new AbortController()
    pending=controller
    const timeout=setTimeout(()=>controller.abort(),20000);timeout.unref?.()
    const still=()=>{
      if(controller.signal.aborted || stopped || uid!==owner() || id!==current())return false
      const live=view()
      return same(v,live) && onDuty(live) && (!topic.ref||sources.valid(topic.ref,id,uid))
    }
    try{
      runtime.change(uid,id,r=>{r.web={...r.web,items:r.web?.items||[],day:v.localDay,attempts:(log.day===v.localDay?log.attempts||0:0)+1,
        shareCount:log.day===v.localDay?log.shareCount||0:0,sequence:seq+1,[channel==='feeds'?'feedRounds':'searchRounds']:rounds+1,
        searchTimes:channel==='search'?[...recentSearches,at]:recentSearches,lastAt:at,status:'reading'}})
      const article=await selectArticle(v,log,channel,topic,controller.signal,still)
      if(!still())return
      runtime.change(uid,id,r=>{r.web.status=article?'read':'empty';if(article)r.web.items=[...r.web.items.slice(-31),article]})
      if(article && c.webMax)await dispatch(v,article,still)
    }catch(err){
      if(!stopped && owner()===uid && current()===id && same(v,view()))runtime.change(uid,id,r=>{if(r.web)r.web.status=err?.message==='no-provider'?'no-provider':'unavailable'})
    }finally{clearTimeout(timeout);pending=null}
  }
  function shareInTurn(to,turn){
    if(!turn || stopped || to!=='private:'+owner())return null
    const v=view(), uid=owner(), id=current(), c=v.config
    if(!onDuty(v)||!c.sharePrivate||!c.webMax)return null
    const row=runtime.read(uid,id), log=row.web
    if(!log || log.day!==v.localDay)return null
    const previous=(log.deliveries||[]).filter(d=>d.to===to)
    const article=[...log.items].reverse().find(a=>{
      if(!valid(a,v) || (a.audience!=='public' && a.audience!==to) || now()-a.at>day)return false
      const attempt=previous.find(d=>d.key===hash(a.url))
      return attempt?attempt.turn===turn:log.shareCount<c.webMax
    })
    if(!article)return null
    const key=hash(article.url)
    if(!previous.some(d=>d.key===key))runtime.change(uid,id,r=>{
      r.web.shareCount++; r.web.deliveries=[...(r.web.deliveries||[]).slice(-79),{key,to,at:now(),turn,state:'offered-to-native-turn'}]
    })
    return {title:article.title,url:article.url,excerpt:article.body.slice(0,180),readAt:article.at}
  }
  return {tick,snapshot,shareInTurn,stop(){stopped=true;pending?.abort()}}
}
