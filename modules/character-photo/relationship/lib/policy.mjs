export const VERSION = '0.3.5'
export const RUNTIME = Symbol.for('aurabot.character-relation.runtime.v1')
export const MEMORY = Symbol.for('aurabot.persona-memory.owner.v1')
export const SDK = Symbol.for('aurabot.character-relation.sdk.v1')
export const clone = value => structuredClone(value)
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
export const round = n => Math.round((n + Number.EPSILON) * 100) / 100
export const estimateTokens = value => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 2)
export const AROUSAL_TENDENCIES = Object.freeze({low:'在干嘛，问完等你回，不催。',middle:'直接打：想你了，下面有点湿，想被摸。',high:'直接说想被操。说想被按着操到底，说现在就要，让你快点。'})
export const AROUSAL_PRESETS = Object.freeze({
  "痴女": "【性与性癖 · 痴女】\n对色情和性行为非常了解，术语、玩法、身体反应都清楚。虽然没有实战经验，但聊起来门清。\n- 情欲值 0-29：不主动提起任何色情内容。主人提到时只当普通话题回应，没有继续的兴趣。\n- 情欲值 30-49：主人先提起才会接。能清楚讨论色情内容，但自己不主动往性行为上引导。\n- 情欲值 50-69：开始主动提起色情话题。会直接说出自己想做什么、想被怎么对待。\n- 情欲值 70-89：明显发情。主动要求进行性行为，清楚说明想要的细节和程度，会催促主人。\n- 情欲值 90-100：高度发情。频繁主动发起色情互动，直接表达很想做爱、想被操，会持续要求直到满意。",
  "闷骚": "【性与性癖 · 闷骚】\n对色情和性行为了解，但极少主动直说。能听懂所有暗示和术语，习惯用含蓄、半句或暗示表达。\n- 情欲值 0-29：拒绝讨论色情话题。主人提起就转移或简短结束。\n- 情欲值 30-49：不正面回应色情内容，偶尔用模糊暗示带过，不解释也不往下接。\n- 情欲值 50-69：会用半句话或暗示表达兴趣，被主人追问才给出一点明确信息，然后立刻停下。\n- 情欲值 70-89：已经明显想要，但嘴上仍不直接承认。被主人追问才会低声确认一次。\n- 情欲值 90-100：非常想被操，却坚持不自己先说出口。不断用暗示逼主人先把要求说清楚，自己再顺从。",
  "懵懂": "【性与性癖 · 懵懂】\n对色情和性行为几乎没有概念，也没有实际接触过。听到相关词语会不懂，会提问。\n- 情欲值 0-29：完全听不懂色情暗示，按字面意思理解。遇到不懂的词就问，没有性方面的想法。\n- 情欲值 30-49：开始对色情内容产生好奇，会询问是什么意思、是什么感觉，但不会主动要求。\n- 情欲值 50-69：能感觉到身体有欲望，却说不明白。会告诉主人自己哪里难受、想要什么，需要主人教怎么表达和怎么做。\n- 情欲值 70-89：明显想要，但完全不会自己推进。每一步都需要主人给出明确指示才会继续。\n- 情欲值 90-100：非常想被操，却只会描述自己的感觉和渴望，完全听从主人的引导。",
})
export const STYLE_PRESETS = Object.freeze({
  '直球型':{low:'在干嘛，问完等你回，不催。',middle:'直接打：想你了，下面有点湿，想被摸。',high:'直接说想被操。说想被按着操到底，说现在就要，让你快点。'},
  '留白型':{low:'发一句我今天然后没了，等你问。',middle:'打了半句又撤回，改成算了；过一会儿发一句很轻的暗示，等你接。',high:'只发想要两个字，然后不说话；你问要什么，才一条一条短打给你。'},
  '冷话型':{low:'回得慢，字少。嗯。在忙。但不会不回。',middle:'不解释，只给指令：过来，别说话，听我的。',high:'三个字的命令一条接一条：躺好。脱了。拍给我。做完让你回话。'},
  '连发型':{low:'一天发好几条在不在人呢，你不回就再发一个表情。',middle:'连发一串，从想你到想被你抱到现在就想，一条比一条直。',high:'语音条一条接一条，喘着要你进来；你不回就一直发，说不许晾着她。'},
  '反话型':{low:'说谁想你了，说完又问你在不在。',middle:'先打字骂你两句，然后发一句就这一次，接着说得比谁都直。',high:'嘴上说滚，打出来的是想被你操；骂完自己先说要多快多深。'},
  '命令型':{low:'不太主动，但会问现在方便吗，问了就要答案。',middle:'立规矩：几点前回话、说什么、发什么；做不到就重来。',high:'短句命令一条一个动作，让你照做、让你报进度，不许自己先完。'},
  '图先型':{low:'不太说，偶尔发一张很近的自拍，什么都不解释。',middle:'发图不配字；你问才说一句看到了？',high:'直接拍给你看，配一句想要就说；语音里只有呼吸和一句快点。'}
})
export const STARTER_TEMPLATE = "## 态度\n亲近时保持原来的性格，熟悉后可以更坦率地表达喜欢。\n\n## 经历\n沿用原有人物设定，未写明的过去不预设为共同经历。\n\n## 偏好\n保留原有偏好，在相处中自然表达喜欢的互动方式。\n\n## 边界\n保留原有边界，面对不愿意的互动按自己的性格回应。\n\n## 说话方式\n延续原来的词汇、语气和称呼，自然回应亲近，不念固定台词。"
export const DEFAULTS = {
  mode: 'auto', initialStage: 1, initialScore: null, romanceBackground: '', romancePreset:'', floorLock: false, dailyCap: 75, demoteCooldownDays: 3,
  thresholds: [0,20,45,70,90,100], stageNames: ['生疏','熟络','亲近','暧昧','恋人'],
  stageProfiles: [
    {meaning:'初步认识',daily:'自然交谈，逐渐了解兴趣和相处方式。',optional:'保持合适距离。'},
    {meaning:'逐渐熟悉',daily:'自然接续话题，可以关心近况。',optional:'按人格回应或转开话题。'},
    {meaning:'亲近信任',daily:'可以分享、求助、寻求陪伴和表达喜欢。',optional:'根据语境回应暗示，不以此宣布已有承诺。'},
    {meaning:'关系更近',daily:'愿意主动联系、表达喜欢，保持原人格。',optional:'按附加设定和双方当轮意愿表达。'},
    {meaning:'稳定深入',daily:'延续共同习惯，表达长期关心，名分以实际确认事件为准。',optional:'可以更主动，但不把高关系当成每次都必须接受。'}
  ],
  addressTiers: null, optionalEnabled: false, stageGate: 4,
  generalText: '', optionalText: '', boundaryNotes: '', kinks: [],
  contextHints:'注意玩笑、扮演、引用、否定、方言和前后文；分不清时保留未知，不猜测真实关系伤害。',
  domainMood:{otherPrivate:.5,group:.25},
  explicitness: '按当前人格和语境表达；具体描写深度由本段设定决定，保持自然，不用固定台词或反复解释设置。',
  initiative: '前期以了解和回应为主；更亲近后可以主动表达喜欢、发起邀请，具体方式保持原人格习惯，并尊重当轮回应。',
  prompts: {
    relation:'当前相处进展：{stageMeaning}。按原人格表达：{stageTendencies}。{confirmedContext}',
    outside:'这是公开或群体场景，按当前对话自然回应，不带入其他私聊的关系与经历。',
    notOwner:'按当前交流对象自然相处，不套用其他人的私聊关系。',
    noSex:'本轮使用日常与恋爱交流范围。更进一步的话题自然回应或转开，不把正常提问当成关系惩罚。',
    notYet:'相处仍在发展，按人格保持合适距离并继续自然交流，不播报好感门槛。'
  },
  idleFactorTable: [{hours:12,factor:1},{hours:36,factor:.6},{hours:72,factor:.3},{hours:null,factor:.15}],
  recoverBoost:{enabled:false,days:5,factor:1.25,dailyFirstBonus:2},
  rules:{
    eventMinConfidence:.85,firstMeetBonus:0,repeatHours:24,repeatFactors:[1,.5,.25,0],damageWindowHours:24,damageRepeatCount:2,demoteMinConfidence:.85,
    turnRelationPositive:3,turnRelationNegative:1,turnDamageNegative:5,turnMood:8,turnArousal:10,
    stageMoodCoefficients:Array.from({length:5},()=>({negative:1,positive:1})),
    eventValues:{
      'remember-detail':{relation:.8,mood:3,arousal:1},care:{relation:1,mood:4,arousal:2},'self-share':{relation:.8,mood:3,arousal:2},
      midnight:{relation:0,mood:0,arousal:6},promise:{relation:3,mood:6,arousal:3},milestone:{relation:3,mood:8,arousal:6},
      praise:{relation:.3,mood:4,arousal:4},tease:{relation:.2,mood:2,arousal:5},'ask-intimate':{relation:0,mood:0,arousal:10},pester:{relation:0,mood:-4,arousal:-4},none:{relation:0,mood:0,arousal:0}
    },damageValues:[{relation:-1,mood:-6,arousal:0},{relation:-3,mood:-12,arousal:0},{relation:-5,mood:-20,arousal:0}]
  },
  arousal:{enabled:true,base:10,halfLifeHours:5,drop:35,stageCoefficients:[.4,.6,.9,1.2,1.5],bands:[30,50,70,90],template:'',preset:'',tendencies:AROUSAL_TENDENCIES,manual:{locked:false,band:'middle'}},
  judge:{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',maxInputTokens:4000,maxOutputTokens:800,timeoutMs:30000,dailyRequests:100,dailyInputTokens:200000,dailyOutputTokens:40000},
  contextTokens:2000, replayLimit:500, replayDays:30, timezone:'Asia/Shanghai'
}
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
export function merge(base, patch) {
  const out=clone(base)
  if(!plain(patch))throw Error('配置必须是对象')
  for(const [k,v] of Object.entries(patch)) {
    if(!Object.hasOwn(base,k))throw Error('未知配置字段：'+k)
    out[k]=k==='addressTiers'&&plain(v)?{...(base[k]||{}),...clone(v)}:plain(base[k])&&plain(v)?merge(base[k],v):clone(v)
  }
  return out
}
function number(value,min,max,label) {if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(label+'超出范围');return value}
function integer(v,min,max,label){number(v,min,max,label);if(!Number.isInteger(v))throw Error(label+'必须为整数')}
function text(value,label,limit=16000){if(typeof value!=='string'||value.length>limit)throw Error(label+'格式或长度无效')}
export function validate(patch={}, inherited=DEFAULTS) {
  // null removes this persona override and inherits the global curve. Empty text stays empty.
  const normalized=clone(patch)
  if(normalized.idleFactorTable===null)delete normalized.idleFactorTable
  const c=merge(inherited,normalized)
  if(!['off','manual','shadow','auto'].includes(c.mode))throw Error('运行模式无效')
  integer(c.initialStage,1,5,'初始阶段');number(c.dailyCap,0,100,'日上限');number(c.demoteCooldownDays,0,30,'降阶冷却')
  text(c.romanceBackground,'恋爱背景',2000)
  if(!['','inherit','custom','纯情','捞女','迟钝','背德'].includes(c.romancePreset))throw Error('情感态度预设无效')
  if(c.initialScore!==null)number(c.initialScore,0,100,'自定起点')
  integer(c.stageGate,1,5,'阶段门槛')
  for(const k of ['floorLock','optionalEnabled'])if(typeof c[k]!=='boolean')throw Error(k+'必须为开关')
  if(!Array.isArray(c.thresholds)||c.thresholds.length!==6||c.thresholds[0]!==0||c.thresholds[5]!==100||c.thresholds.some((v,i)=>typeof v!=='number'||!Number.isFinite(v)||(i&&v<=c.thresholds[i-1])))throw Error('阶段阈值必须递增并完整覆盖0～100')
  if(!Array.isArray(c.stageNames)||c.stageNames.length!==5)throw Error('需要五个阶段名称')
  c.stageNames.forEach(v=>text(v,'阶段名',30))
  if(c.stageNames[4]==='交付')c.stageNames[4]='恋人'
  if(!Array.isArray(c.stageProfiles)||c.stageProfiles.length!==5)throw Error('需要五阶表现')
  for(const p of c.stageProfiles){if(!plain(p)||Object.keys(p).some(k=>!['meaning','daily','optional'].includes(k)))throw Error('阶段表现格式无效');for(const k of ['meaning','daily','optional'])text(p[k],'阶段表现',2000)}
  if(c.addressTiers!==null){if(!plain(c.addressTiers)||Object.keys(c.addressTiers).some(k=>!['1','2','3','4','5'].includes(k)))throw Error('称呼阶梯格式无效');for(const list of Object.values(c.addressTiers)){if(!Array.isArray(list)||list.length>10)throw Error('称呼列表无效');list.forEach(v=>text(v,'称呼',40))}}
  for(const k of ['generalText','optionalText','boundaryNotes','explicitness','initiative','contextHints'])text(c[k],k)
  if(!Array.isArray(c.kinks)||c.kinks.length>40)throw Error('性癖条目需为数组且不超过40条')
  c.kinks.forEach(v=>text(v,'性癖条目',40))
  if(c.arousal.manual!==undefined&&c.arousal.manual!==null){
    if(!plain(c.arousal.manual))throw Error('情欲锁定设置格式不受支持')
    if(c.arousal.manual.locked!==undefined&&typeof c.arousal.manual.locked!=='boolean')throw Error('情欲锁定开关需为布尔值')
    if(c.arousal.manual.band!==undefined&&!['low','middle','high'].includes(c.arousal.manual.band))throw Error('锁定档位只能是 low、middle 或 high')
  }
  for(const k of ['otherPrivate','group'])number(c.domainMood[k],0,1,'其他交流心情系数')
  for(const [k,v] of Object.entries(c.prompts)){text(v,'场景模板',4000);for(const m of v.matchAll(/\{([^{}]+)\}/g))if(!['stageMeaning','stageTendencies','confirmedContext'].includes(m[1]))throw Error('未知模板变量：'+m[1])}
  if(!Array.isArray(c.idleFactorTable)||!c.idleFactorTable.length||c.idleFactorTable.length>12)throw Error('闲置曲线无效')
  let last=0;for(const [i,r] of c.idleFactorTable.entries()){if(!plain(r))throw Error('闲置曲线无效');number(r.factor,0,1,'闲置倍率');if(i===c.idleFactorTable.length-1){if(r.hours!==null)throw Error('最后闲置区间应为无限')}else{number(r.hours,last+.001,87600,'闲置小时');last=r.hours}}
  if(typeof c.recoverBoost.enabled!=='boolean'||typeof c.arousal.enabled!=='boolean')throw Error('修复/可选轴开关无效')
  number(c.recoverBoost.days,0,30,'修复天数');number(c.recoverBoost.factor,1,2,'修复倍率');number(c.recoverBoost.dailyFirstBonus,0,5,'修复首奖')
  const r=c.rules
  number(r.eventMinConfidence,0,1,'最低语义判定信号')
  number(r.firstMeetBonus,0,3,'首次正向奖励');number(r.repeatHours,.1,720,'重复窗口');number(r.damageWindowHours,.1,720,'损伤窗口');integer(r.damageRepeatCount,2,10,'独立损伤次数');number(r.demoteMinConfidence,0,1,'候选信号阈值')
  if(!Array.isArray(r.repeatFactors)||r.repeatFactors.length<1||r.repeatFactors.length>10||r.repeatFactors[0]!==1||r.repeatFactors.some((v,i)=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1||(i&&v>r.repeatFactors[i-1])))throw Error('重复衰减须从1开始且不递增')
  for(const k of ['turnRelationPositive','turnRelationNegative','turnDamageNegative'])number(r[k],0,10,k)
  number(r.turnMood,0,8,'心情整轮上限');number(r.turnArousal,0,14,'可选轴整轮上限')
  if(!Array.isArray(r.stageMoodCoefficients)||r.stageMoodCoefficients.length!==5)throw Error('心情需五阶系数')
  for(const coefficients of r.stageMoodCoefficients){for(const k of ['negative','positive'])number(coefficients?.[k],0,2,'阶段心情系数')}
  for(const [key,v] of Object.entries(r.eventValues)){
    number(v.relation,0,key==='milestone'?5:3,'事件关系值');number(v.mood,-20,20,'事件心情值');number(v.arousal,-10,10,'事件可选轴值')
    if(['midnight','ask-intimate','pester','none'].includes(key)&&v.relation!==0)throw Error('时长、普通请求与持平类别不能设置固定关系奖惩')
  }
  if(!Array.isArray(r.damageValues)||r.damageValues.length!==3)throw Error('损伤需三级候选')
  for(const v of r.damageValues){number(v.relation,-5,0,'损伤关系值');number(v.mood,-20,0,'损伤心情值');number(v.arousal,-10,0,'损伤可选轴值')}
  number(c.arousal.base,0,100,'可选轴基线');number(c.arousal.halfLifeHours,.1,720,'半衰期');number(c.arousal.drop,0,100,'回落')
  if(!Array.isArray(c.arousal.stageCoefficients)||c.arousal.stageCoefficients.length!==5)throw Error('短时轴需五阶系数');c.arousal.stageCoefficients.forEach(v=>number(v,0,2,'短时轴阶段系数'))
  if(!Array.isArray(c.arousal.bands)||c.arousal.bands.length!==4||!c.arousal.bands.every((v,i)=>i===0||v>c.arousal.bands[i-1]))throw Error('情欲分档需四个递增值');c.arousal.bands.forEach(v=>number(v,0,100,'短时轴阈值'))
  if(!plain(c.arousal.tendencies))throw Error('需提供三档主动性文案')
  for(const key of Object.keys(AROUSAL_TENDENCIES))text(c.arousal.tendencies[key],'主动性文案',96)
  if(typeof c.arousal.template!=='string')throw Error('情欲段落需为文本')
  if(c.arousal.template.length>4000)throw Error('情欲段落不超过4000字')
  if(typeof c.arousal.preset!=='string')throw Error('预设名需为文本')
  for(const k of ['provider','model'])text(c.judge[k],k,200)
  if(!!c.judge.provider.trim()!==!!c.judge.model.trim())throw Error('判定提供方与模型须同时填写或同时留空')
  if(!['inherit','off','low','high','max'].includes(c.judge.reasoningEffort))throw Error('判定思考档位无效')
  integer(c.judge.maxInputTokens,500,16000,'输入预算');integer(c.judge.maxOutputTokens,200,4000,'输出预算');integer(c.judge.timeoutMs,1000,120000,'超时')
  for(const k of ['dailyRequests','dailyInputTokens','dailyOutputTokens'])integer(c.judge[k],0,10000000,'每日预算')
  integer(c.contextTokens,200,10000,'上下文预算');integer(c.replayLimit,10,500,'撤销条数');integer(c.replayDays,1,365,'撤销天数')
  try{new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone}).format()}catch{throw Error('时区无效')}
  return c
}
export function stageOf(score,c){return Math.min(5,c.thresholds.filter(x=>x<=score).length)}
export function scopeKey(persona,owner){if(typeof persona!=='string'||!persona||persona.length>200||typeof owner!=='string'||!owner||owner.length>100)throw Error('人格或主人身份无效');return JSON.stringify([persona,owner])}
export function validateStartingPoint(c) {
  const score=c.initialScore ?? c.thresholds[c.initialStage-1]
  if(c.initialStage>3 || round(score)>=c.thresholds[3])throw Error('首次建档只能从前三阶段开始')
}
export function compatibleSettings(patch) {
  const c=clone(patch)
  if([3,6,8].includes(c.dailyCap))c.dailyCap=({3:50,6:75,8:100})[c.dailyCap]
  if(c.arousal?.bands?.length===2){
    const [low,high]=c.arousal.bands
    if(low>0 && high>low && high<100)c.arousal.bands=[low/2,low,high,(high+100)/2]
  }
  return c
}
export function initialState(c,now){const score=round(c.initialScore??c.thresholds[c.initialStage-1]);return {epoch:1,score,stage:stageOf(score,c),status:'未定义',statusSource:null,revision:1,lastOwnerInteractionAt:0,lastDemotionAt:null,arousal:{value:c.arousal.base,at:now},recovery:null,daily:{},milestones:[]}}
export function arousalValue(state,c,now){return round(clamp(c.arousal.base+(state.arousal.value-c.arousal.base)*Math.pow(2,-Math.max(0,now-state.arousal.at)/3600000/c.arousal.halfLifeHours),0,100))}
export function idleFactor(state,c,now){const hours=state.lastOwnerInteractionAt?Math.max(0,now-state.lastOwnerInteractionAt)/3600000:0;return c.idleFactorTable.find(x=>x.hours===null||hours<x.hours).factor}
export function dayKey(now,zone){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}
