const {useState,useEffect,useRef}=React
const src=id=>'/aurabot/api/ext/character-photo/image?id='+encodeURIComponent(id)
const css=`.cp-panel .cp-reference-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.cp-panel .cp-body-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}@media(max-width:900px){.cp-panel .cp-reference-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cp-panel .cp-body-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:600px){.cp-panel .cp-reference-grid{grid-template-columns:1fr}.cp-panel .cp-body-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cp-panel .cp-nav-end{display:flex;align-items:center;gap:8px;margin-inline-start:auto;min-width:0;max-width:100%}
.cp-panel .cp-nav-end .cp-persona-select{width:clamp(112px,17vw,200px);min-width:76px;flex:1 1 auto}
.cp-panel .cp-record-list{display:grid;gap:4px}
.cp-panel .cp-record-row{display:grid;grid-template-columns:minmax(0,1fr) auto;text-align:start;width:100%;padding:8px 10px;border:1px solid var(--ab-border,#dfe5ee);border-radius:8px;background:var(--ab-surface,#fff);color:inherit;cursor:pointer;gap:6px 12px;align-items:center;overflow-wrap:anywhere}
.cp-panel .cp-record-row:hover,.cp-panel .cp-record-row:focus-visible{background:var(--ab-surface-muted,#eef4fc)}
.cp-panel .cp-record-row small{color:var(--ab-muted,#748092);white-space:nowrap}
.cp-panel .cp-reading-filters{justify-content:space-between}.cp-panel .cp-reading-filters .ab-input{width:148px;flex:0 1 auto}
.cp-panel .cp-pager{justify-content:flex-end;gap:8px}.cp-panel .cp-pager label{display:flex;align-items:center;gap:6px;margin:0;white-space:nowrap}.cp-panel .cp-pager select{width:72px}
.cp-panel .cp-option{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:40px;margin:0;font-size:13px;font-weight:600}
@media(max-width:500px){.cp-panel .cp-nav-end{margin-inline-start:0;width:100%}.cp-panel .cp-record-row{grid-template-columns:1fr}}
.cp-panel .cp-title-row{justify-content:space-between}.cp-panel .cp-life-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.cp-panel .cp-life-summary .cp-box{align-content:start}.cp-panel .cp-life-now{background:var(--ab-surface,#f6f9fd)}.cp-panel .cp-life-now .cp-row{justify-content:space-between}.cp-panel .cp-check{display:inline-flex;align-items:center;gap:6px;min-height:40px;margin:0}.cp-panel .cp-check input{margin:0}.cp-panel .cp-agenda,.cp-panel .cp-evidence{list-style:none;padding:0;margin:0}.cp-panel .cp-agenda li{display:grid;grid-template-columns:minmax(108px,auto) minmax(0,1fr) auto;gap:12px;align-items:center;min-height:42px;padding:8px 10px;border-bottom:1px solid var(--ab-border,#dfe5ee);font-variant-numeric:tabular-nums}.cp-panel .cp-agenda li:last-child{border-bottom:0}.cp-panel .cp-agenda .cp-now{background:#eef4fc;border-radius:8px}.cp-panel .cp-agenda small{color:var(--ab-muted,#748092)}.cp-panel .cp-reading,.cp-panel .cp-change{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:0}.cp-panel .cp-evidence li{padding-block:10px;border-bottom:1px solid var(--ab-border,#dfe5ee)}.cp-panel .cp-section summary{cursor:pointer;margin-bottom:8px}
@media(max-width:480px){.cp-panel .cp-life-summary{grid-template-columns:1fr}.cp-panel .cp-agenda li{grid-template-columns:minmax(80px,auto) minmax(0,1fr);gap:6px 9px}.cp-panel .cp-agenda small{grid-column:2}}
.cp-panel{display:grid;gap:18px;min-width:0}.cp-panel *{box-sizing:border-box}.cp-panel button,.cp-panel input,.cp-panel select,.cp-panel textarea{font:inherit}
.cp-panel .cp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.cp-panel .cp-row>h3{margin:0;flex:1;min-width:140px}.cp-panel .cp-row>select,.cp-panel .cp-row>input:not([type=checkbox]){flex:1;min-width:120px}
.cp-panel .cp-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;align-items:start}.cp-panel .cp-three{grid-template-columns:repeat(3,minmax(0,1fr))}
.cp-panel .cp-stack{display:grid;gap:16px;min-width:0}.cp-panel .cp-field{display:grid;gap:8px;min-width:0;margin:0}.cp-panel .cp-label{font-size:13px;font-weight:600;line-height:20px}.cp-panel .cp-hint{color:var(--ab-muted,#748092);font-size:12px;line-height:1.7;margin:0}
.cp-panel .ab-input{margin:0;width:100%;min-width:0;max-width:100%;height:40px;line-height:20px;vertical-align:top}.cp-panel textarea.ab-input{height:88px;resize:vertical;line-height:1.6;padding:10px}.cp-panel .ab-btn{min-height:40px;margin:0;line-height:20px;display:inline-flex;align-items:center;justify-content:center;white-space:normal;flex-shrink:0}
.cp-panel .cp-tabs{display:flex;flex-wrap:wrap;gap:8px}.cp-panel .cp-settings-tab{margin-inline-start:auto}.cp-panel .cp-box{display:grid;gap:14px;border:1px solid var(--ab-border,#dfe5ee);border-radius:12px;padding:16px;min-width:0}.cp-panel .cp-section{border-top:1px solid var(--ab-border,#dfe5ee);padding-top:18px}.cp-panel .cp-subtitle{margin:0;font-size:14px}
.cp-panel .cp-image{display:flex;align-items:center;justify-content:center;width:100%;height:180px;padding:0;border:0;border-radius:10px;background:#f4f5f8;overflow:hidden;cursor:zoom-in}.cp-panel .cp-image img{width:100%;height:100%;object-fit:contain;display:block}.cp-panel .cp-image:disabled{cursor:default;color:#748092}.cp-panel .cp-placeholder{font-size:13px}
.cp-panel .cp-upload{position:relative;display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 16px;border:1px solid var(--ab-border,#dfe5ee);border-radius:9px;cursor:pointer;font-size:13px;background:white;line-height:20px}.cp-panel .cp-upload input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}.cp-panel .cp-upload.busy{opacity:.5;pointer-events:none}
.cp-panel .cp-album{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));gap:16px}.cp-panel .cp-album>.cp-box{display:flex;flex-direction:column}.cp-panel .cp-annotation summary{cursor:pointer;line-height:1.6}.cp-panel .cp-annotation[open] summary{margin-bottom:8px}.cp-panel .cp-annotation .cp-stack{gap:8px}.cp-panel .cp-album .cp-row{margin-top:auto}.cp-panel .cp-album p{margin:0;overflow-wrap:anywhere;line-height:1.6}.cp-panel .cp-status{border-radius:9px;padding:12px 14px;background:#eef4fc;line-height:1.7;overflow-wrap:anywhere}.cp-panel .cp-error{background:#fff1ed;color:#963a25}.cp-panel .cp-empty{text-align:center;padding:28px 14px;border:1px dashed #dce3ed;border-radius:10px;color:#748092}
.cp-panel .cp-switch{display:flex;align-items:center;gap:8px;height:40px;white-space:nowrap;cursor:pointer}.cp-panel .cp-switch input{appearance:none;width:40px;height:24px;border-radius:20px;background:#dce0e5;margin:0;position:relative;cursor:pointer}.cp-panel .cp-switch input:checked{background:#397fda}.cp-panel .cp-switch input:after{content:'';position:absolute;width:18px;height:18px;background:white;border-radius:50%;left:3px;top:3px;transition:transform .15s}.cp-panel .cp-switch input:checked:after{transform:translateX(16px)}
.cp-viewer{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.88);display:flex;flex-direction:column;padding:18px;gap:12px}.cp-viewer .cp-row{justify-content:flex-end}.cp-viewer .cp-viewarea{flex:1;min-height:0;overflow:auto;display:grid;place-items:center}.cp-viewer img{max-width:100%;max-height:calc(100vh - 105px);object-fit:contain}.cp-viewer img.cp-zoom{max-width:none;max-height:none}.cp-viewer button{background:white}.cp-panel .cp-preview{max-height:520px;height:auto;min-height:180px}.cp-panel .cp-preview img{max-height:520px}
@media(max-width:650px){.cp-panel .cp-grid,.cp-panel .cp-three{grid-template-columns:1fr}.cp-panel .cp-box{padding:12px}.cp-panel .cp-row>h3{min-width:100px}.cp-panel .cp-tabs{gap:5px}.cp-panel .cp-image{height:160px}}
.cp-panel .cp-dashboard{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}.cp-panel .cp-dashboard>.cp-section,.cp-panel .cp-dashboard>.cp-life-summary{border:1px solid var(--ab-border,#87968a66);border-radius:12px;padding:14px;min-width:0}.cp-panel .cp-dashboard .cp-subtitle{font-weight:650}.cp-panel .cp-material-nav{grid-template-columns:repeat(4,minmax(0,1fr))}.cp-panel .cp-material-nav button{min-height:44px}.cp-panel .cp-preset-card small{font-size:12px;opacity:.82}@media(max-width:650px){.cp-panel .cp-dashboard{grid-template-columns:1fr}.cp-panel .cp-material-nav{grid-template-columns:1fr 1fr}}
`
const wordStyle='.cp-word-group{border:0;padding:0;margin:0}.cp-word-group legend{font-weight:600;margin-bottom:5px}.cp-word-group input{max-width:26em;margin-top:5px}.cp-word-group button[aria-pressed=true]{background:var(--ab-primary,#3d7fd6);color:white}'
const moduleStyle=`
.cp-panel .cp-origin{width:auto;max-width:100%;min-width:5em}
.cp-panel .cp-shot-compose{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr);gap:14px}
.cp-panel .cp-shot-compose>.cp-section{background:var(--ab-tint,#f3f7fc);border:0;border-radius:12px;padding:14px}
.cp-panel .cp-shot-reference img{height:135px;object-fit:contain}
@media(max-width:600px){.cp-panel .cp-shot-compose{grid-template-columns:minmax(0,1fr)}}
.cp-panel .cp-head-spacer{flex:1 1 auto}
.cp-panel [hidden]{display:none!important}
.cp-panel .cp-life h3,.cp-panel .cp-life h4{margin:0}
.cp-panel .cp-life-now,.cp-panel .cp-life-columns{display:grid;gap:14px;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);align-items:start}
.cp-panel .cp-life-now>.cp-section,.cp-panel .cp-life-columns .cp-section{border:0;border-radius:12px;padding:16px;background:var(--ab-tint,#f5f8fc);box-shadow:none}
.cp-panel .cp-life-now>.cp-section:first-child{background:linear-gradient(115deg,#eaf3ff,#f5f9ff)}
.cp-panel .cp-life-columns .cp-growth{background:linear-gradient(140deg,#edf8f5,transparent 35%)}
.cp-panel .cp-life-columns>.cp-stack>.cp-section:first-child{background:linear-gradient(125deg,#fcf1f5,#fff9fb)}
.cp-panel .cp-life-headline{font-size:clamp(17px,2vw,22px);line-height:1.4}
.cp-panel .cp-badge{color:#85506f;background:#fcf0f6;border-radius:12px;padding:2px 9px;font-size:12px}
.cp-panel .cp-journal-entry{display:grid;gap:2px}.cp-panel .cp-journal-entry small{color:var(--ab-sub,#5c6579)}
.cp-panel .cp-growth .cp-record-list{gap:0}
.cp-panel .cp-growth .cp-record-row{grid-template-columns:3.3em minmax(0,1fr);padding:7px 0;border:0;background:transparent;gap:10px;border-radius:0}
.cp-panel .cp-growth .cp-record-row>time{font-size:12px;color:var(--ab-sub,#647780);font-variant-numeric:tabular-nums;align-self:start;line-height:1.7}
.cp-panel .cp-growth .cp-record-row>span{position:relative;display:grid;gap:3px;padding-inline-start:13px}
.cp-panel .cp-growth .cp-record-row>span:before{content:"";position:absolute;left:0;top:.52em;width:7px;height:7px;border-radius:50%;background:#5c9f92}
.cp-panel .cp-growth .cp-record-row:not(:last-child)>span:after{content:"";position:absolute;left:3px;top:1.15em;height:calc(100% + 1px);width:1px;background:#cde0dc}
.cp-panel .cp-growth .cp-tabs .ab-btn,.cp-panel .cp-growth .cp-title-row .ab-btn{padding:3px 7px;min-height:28px;font-size:12px}
.cp-panel .cp-growth .cp-reading-filters{align-items:flex-start}
.cp-panel .cp-life-dialog{box-sizing:border-box;border:1px solid var(--ab-line,#dbe1eb);border-radius:16px;box-shadow:0 24px 90px #1b2e4a33;width:min(780px,calc(100vw - 28px));max-height:85dvh;overflow:auto;scrollbar-width:thin;padding:0;color:inherit;background:var(--ab-card,#fff)}
.cp-panel .cp-life-dialog::backdrop{background:#27364855}
.cp-panel .cp-life-dialog>.cp-stack{padding:20px}.cp-panel .cp-life-dialog .cp-grid{align-items:start}
.cp-panel .cp-life-dialog input,.cp-panel .cp-life-dialog select{box-sizing:border-box;max-width:100%;min-width:0}
.cp-panel .cp-material-nav{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.cp-panel .cp-material-nav button{display:flex;align-items:center;justify-content:center;gap:7px;border-radius:10px}
.cp-panel .cp-material-nav button[aria-pressed=true],.cp-panel .cp-material-tile[aria-pressed=true]{outline:2px solid var(--ab-sea,#4288de);outline-offset:-2px;background:#edf4fe;color:#234a77}
.cp-panel .cp-import-entry{border-style:dashed;padding:12px 17px;border-radius:10px}
.cp-panel .cp-material-grid,.cp-panel .cp-review-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(140px,100%),1fr));gap:10px}
.cp-panel .cp-review-images img,.cp-panel .cp-material-tile img{width:100%;height:120px;object-fit:contain;border-radius:8px;background:var(--ab-tint,#f3f6fa)}
.cp-panel .cp-material-tile{padding:8px;border:1px solid #dbe3ee;background:var(--ab-card,#fff);border-radius:12px;display:grid;gap:5px;color:inherit;text-align:start;cursor:pointer}
.cp-panel .cp-career-button,.cp-panel .cp-preset-card strong{display:inline-flex;align-items:center;gap:6px}
.cp-panel .cp-career-button{min-height:28px;padding:1px 9px 1px 4px;border:0;color:#52647b;background:#f0f4fa;border-radius:16px;cursor:pointer}
.cp-panel .cp-career-button>span:last-child{font-size:12px;line-height:1}
.cp-panel .cp-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;color:var(--cp-tone,#4d80b2);background:color-mix(in srgb,currentColor 12%,transparent);border-radius:7px;flex:none}
.cp-panel .cp-subtitle{display:inline-flex;align-items:center;gap:7px}
.cp-panel .cp-field .ab-input{box-sizing:border-box;min-width:0}
.cp-panel details>summary{cursor:pointer;line-height:1.5}
@media(max-width:700px){.cp-panel .cp-life-now,.cp-panel .cp-life-columns{grid-template-columns:minmax(0,1fr)}.cp-panel .cp-material-nav{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
const sectionArt={
 '成长与经历':['#368f79','M4 17c7-1 12-8 14-13 3 10-1 17-10 15 M4 21l9-10'],'当前生活':['#3b85c5','M12 3v2m0 14v2M3 12h2m14 0h2M5 5l2 2m10 10 2 2 M12 7a5 5 0 1 1 0 10a5 5 0 1 1 0-10'],'接下来的安排':['#7d74af','M4 5h16v15H4z M8 3v4m8-4v4M4 10h16'],'生活手账':['#aa668c','M3 5q5-2 9 1 4-3 9-1v13q-5-2-9 1-4-3-9-1z M12 6v13'],'最近活动':['#ae793f','M3 13h5l2-7 4 13 2-8 2 2h3'],
 identity:['#7773b4','M12 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8 M4 21v-2a8 7 0 0 1 16 0v2'],outfit:['#ac687e','M8 4L2 8l3 5 3-1v8h8v-8l3 1 3-5-6-4q-4 4-8 0z'],scene:['#438a75','M3 4h18v16H3z M3 16l5-5 4 4 3-3 6 5 M16 7h.1'],object:['#a27941','M3 8l9-5 9 5-9 5z M3 8v9l9 5 9-5V8 M12 13v9']
}
const occupationArt={"teacher": ["#4c7aaa", "<path d=\"M3 4h18v12H3zM12 16v4m-4 1 4-2 4 2M6 8h6m-6 4h3\"/>"], "secondary": ["#9d7535", "<path d=\"M9 5V4a3 3 0 0 1 6 0v1M4.5 12a7.5 7.5 0 0 1 15 0v8H4.5zM8 20v-6h8v6M7 11h10\"/>"], "university": ["#7569a9", "<path d=\"m2 9 10-5 10 5-10 5zM6.5 12v4c3.5 3 7.5 3 11 0v-4M21 10v6\"/>"], "nurse": ["#a5628b", "<rect x=\"3\" y=\"7\" width=\"18\" height=\"14\" rx=\"3\"/><path d=\"M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-4 4v6m-3-3h6\"/>"], "doctor": ["#388675", "<path d=\"M4 3v6a4 4 0 0 0 8 0V3M3 3h3m5 0h2M8 13v1a6 6 0 0 0 12 0v-2\"/><circle cx=\"19\" cy=\"9\" r=\"2.5\"/>"], "office": ["#4c7aaa", "<rect x=\"2\" y=\"7\" width=\"20\" height=\"14\" rx=\"2\"/><path d=\"M8 7V4h8v3M3 13h18m-11 0v2h4v-2\"/>"], "executive": ["#7569a9", "<path d=\"M3 21h18M6 21V5l10-3v19m0-10h4v10M9 8h1m2-1h1m-4 5h1m2-1h1m-4 5h1m2-1h1\"/>"], "creator": ["#a5628b", "<path d=\"M13 3c5 0 9 3.7 9 8 0 2-1.6 3-4 3h-2c-1.4 0-2.2 1.3-1.6 2.6.8 2-.3 4.4-3.1 4.4A8.8 8.8 0 0 1 3 12c0-5 4.5-9 10-9Z\"/><path d=\"M7.5 10h.1m3.1-3h.1m4.5-.4h.1m2.2 2.8h.1\" stroke-width=\"2.5\"/>"], "streamer": ["#388675", "<rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\"/><path d=\"m16 10 5-3v10l-5-3\"/><circle cx=\"6\" cy=\"10\" r=\"1\"/>"], "police": ["#4c7aaa", "<path d=\"m12 2 8 4v6c0 4-3 7-8 10-5-3-8-6-8-10V6z\"/><path d=\"m8.5 12 2.5 2.5 4.5-5\"/>"], "cabin": ["#388675", "<path d=\"m21 3-6 18-3-8-8-3 17-7Zm-9 10 5-6\"/>"], "shrine": ["#a5628b", "<path d=\"M2 5q10 3 20 0M3 10h18M7 7 6 21m11-14 1 14M10 7v3m4-3v3\"/>"], "star": ["#7569a9", "<path d=\"m3 8 17-5 1 5-17 5zM4 13h17v8H4zM7 7l3 4m2-6 3 4m2-5 3 4\"/>"], "idol": ["#9d7535", "<rect x=\"9\" y=\"2\" width=\"6\" height=\"12\" rx=\"3\"/><path d=\"M5 10a7 7 0 0 0 14 0m-7 7v4m-4 0h8\"/>"], "voice": ["#388675", "<path d=\"M3 13a9 9 0 0 1 18 0v5m-18-5v5\"/><rect x=\"3\" y=\"12\" width=\"4\" height=\"8\" rx=\"2\"/><rect x=\"17\" y=\"12\" width=\"4\" height=\"8\" rx=\"2\"/>"], "heiress": ["#7569a9", "<path d=\"M3 9 7 4h10l4 5-9 12zM3 9h18M12 21 8 9l4-5 4 5z\"/>"], "custom": ["#4c7aaa", "<path d=\"m4 16 11-11 4 4L8 20l-5 1 1-5Zm9-9 4 4\"/>"]}

const badgeIcon=key=>{
 const d=sectionArt[key];if(!d)return null
 return h('span',{className:'cp-icon',style:{'--cp-tone':d[0]},'aria-hidden':true},h('svg',{width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round'},h('path',{d:d[1]})))
}
const hint=t=>h('p',{className:'cp-hint'},t)
const row=(...x)=>h('div',{className:'cp-row'},...x)
const stack=(...x)=>h('div',{className:'cp-stack'},...x)
const grid=(...x)=>h('div',{className:'cp-grid'},...x)
const field=(title,control,help)=>h('label',{className:'cp-field'},h('span',{className:'cp-label'},title),control,help?hint(help):null)
const input=(value,set,placeholder='',type='text',list)=>h('input',{className:'ab-input',list,value:value??'',type,placeholder,onChange:e=>set(e.target.value)})
const area=(value,set,placeholder='')=>h('textarea',{className:'ab-input',value:value??'',placeholder,onChange:e=>set(e.target.value)})
const select=(value,set,items)=>h('select',{className:'ab-input',value:value??'',onChange:e=>set(e.target.value)},...items.map(([v,l])=>h('option',{key:v,value:v},l)))
const bool=(value,set)=>select(String(Boolean(value)),v=>set(v==='true'),[['true','开启'],['false','关闭']])
const weekdays=[[1,'周一'],[2,'周二'],[3,'周三'],[4,'周四'],[5,'周五'],[6,'周六'],[0,'周日']]
const phases=[['sleep','睡眠'],['work','工作 / 学习'],['commute','通勤'],['free','自由安排'],['arranged','临时日程']]
const phaseName=phase=>phases.find(([key])=>key===phase)?.[1]||'自由安排'
const workNames={dream:'梦境',diary:'私人日记',concern:'心事',event:'生活见闻',reflect:'习惯整理',habit:'习惯',preference:'偏好',opinion:'普通观点'}
const recordStatus={trying:'尝试',candidate:'候选',stable:'稳定',shelved:'搁置',revoked:'已撤销'}
const sourceNames={'user-message':'原话','confirmed-activity':'已确认事项','tool-receipt':'工具回执','simulated-event':'模拟生活见闻'}
function pageOf(items,requested,size){
  const pages=Math.max(1,Math.ceil(items.length/size)),page=Math.min(requested,pages)
  return {page,pages,total:items.length,items:items.slice((page-1)*size,page*size)}
}
const timetableModes=[['basic','基础作息'],['weekly','每周日程'],['rotation','轮班日程']]
const presetFields={scheduleMode:'日程方式',rotationDays:'轮班周期',scheduleBlocks:'班表',sleepStart:'入睡时间',wakeTime:'起床时间',workLabel:'工作说明',workPlace:'工作地点',workEnabled:'工作安排',items:'常用物品',notes:'生活与分享示例',mode:'作息弹性',flexMinutes:'浮动分钟',interests:'闲暇活动',places:'常去地点'}
const displayValue=(key,value)=>key==='scheduleMode'?timetableModes.find(([id])=>id===value)?.[1]:key==='mode'?({fixed:'固定',flexible:'弹性'}[value]):Array.isArray(value)?value.join('、')||'空':String(value??'空')
const localDate=(at,timezone)=>new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at)
const jobLabel=j=>j.origin==='material'?(({'identity-convert':'人设三视图转换',board:'素材制版',analyze:'素材识别',collect:'聊天收藏'}[j.stage]||'素材处理')+' · '+({planning:'识别中',generating:'生成中',generated:'已完成',unknown:'结果待核对',failed:'未完成',skipped:'未收藏'}[j.status]||j.status)):({queued:'等待处理',planning:'准备附图',generating:'生成中',generated:'图片已入册',sent:'已发送',failed:'未完成',unknown:'结果待核对'}[j.status]||j.status)+(j.status==='queued'&&['intent','outfit'].includes(j.stage)?' · '+({intent:'正在理解画面需求',outfit:'正在规划穿搭'}[j.stage]):'')
const jobFailure=j=>{
  const e=String(j.error||'')
  if(/safety system|safety_violations|content_policy|moderation/i.test(e)){const id=e.match(/\breq_[a-zA-Z0-9_-]+\b/)?.[0];return '图片服务拒绝了本次请求（安全审核）。未自动重试。'+(id?' 请求编号：'+id:'')}
  if(e==='视觉意图未能确认，未生成或发送图片')return '后台索图规划返回的 JSON 无法解析，尚未调用生图服务。此旧记录没有保留原始返回，无法判断是空回复、截断还是非 JSON。'
  if(e==='尚未确认内容的相处范围，请补充明确要求')return '后台规划未取得确定的内容分类，尚未调用生图服务。此旧记录不能区分漏填分类和模型明确表示不确定。'
  return e
}
// Reviewed workbench assets (generated by build-reviewed-styles.py)
/* dsh-image-studio 0.5.1 · lib/vision.js and lib/sheets.js
MIT License

Copyright (c) 2026 aa1355721445-lgtm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const FOCUS = {
  characters: {
    role: '角色设定整理助手',
    focus: '只描述人物外貌：脸型五官、发型与发色、瞳色、肤色、体型比例、年龄感、标志性特征（兽耳、尾巴、角、翅膀、饰品等），服装只用一句话概括。不要写姿势、表情神态（如「笑容」「脸红」）、动作和背景——这些每张图都会变，写进去会让以后每张图都长一个样。',
    name: '认得出是哪个角色就用角色名，否则按特征起名，如「蓝发鲸鱼娘」',
    tags: '画风、发色、体型、种族特征、气质等',
  },
  outfits: {
    role: '服装设计整理助手',
    focus: '只描述服装本身，完全忽略穿着者的长相、姿势和背景：服装类型与版型、长度、颜色搭配、面料材质、图案、领口 / 袖口 / 裙摆等结构细节、纽扣拉链蕾丝等装饰、鞋袜和配饰。图里有多件时描述整套穿搭（除非补充说明另有指定）。',
    name: '按款式起名，如「蓝白女仆装」「米色针织开衫」',
    tags: '风格（如 JK、洛丽塔、中式、通勤、运动）、季节、场合、主色、材质',
  },
  scenes: {
    role: '场景设定整理助手',
    focus: '只描述空间本身，忽略画面里的人物：空间类型与大小、布局、主要家具和陈设、材质、配色、光线与时间、时代与风格。',
    name: '按空间起名，如「暖光小卧室」「海边咖啡馆」',
    tags: '室内 / 室外、空间类型、风格、色调、氛围、适合做的事',
  },
  props: {
    role: '道具设计整理助手',
    focus: '只描述这个物品：类别、外形结构、尺寸感、颜色、材质、纹理图案和细节，忽略拿着它的手和背景。',
    name: '按物品起名，如「鲸鱼抱枕」「复古胶片相机」',
    tags: '类别、材质、颜色、风格、用途',
  },
}

function analyzePrompt(category, hint) {
  const f = FOCUS[category] || FOCUS.props
  return [
    `你是一名${f.role}。请仔细观察图片，为生图参考库整理一个条目。`,
    f.focus,
    '不要描述图片本身的版式（如「三视图」「设定图」「细节特写框」「排版」），只描述画的东西。',
    hint ? `用户的补充说明（优先遵守）：${hint}` : '',
    '只输出一个 JSON 对象，不要输出任何其他文字或代码块标记：',
    '{',
    `  "name": "简短好记的中文名，2–10 个字；${f.name}",`,
    '  "aliases": ["0–3 个别名或常见叫法"],',
    `  "tags": ["5–10 个短标签：${f.tags}"],`,
    '  "description": "给生图模型看的外观描述，80–220 字，写具体可画的细节（颜色、形状、材质、位置关系），不写主观评价"',
    '}',
  ].filter(Boolean).join('\n')
}

const SHEET_ASPECT = { characters: '16:9', outfits: '16:9', props: '16:9', scenes: '4:3' }

const SHEET_PROMPTS = {
  characters: [
    '根据参考图中的角色，画一张标准的角色设定三视图（character turnaround sheet）。',
    '· 同一个角色的正面、侧面（面朝右）、背面三个全身像，从左到右横向等距排列；三个视图大小一致，头顶和脚底对齐，全身完整入画、不被裁切。',
    '· 姿势统一为自然站立的 A 字站姿：双臂自然下垂、微微离开身体，双脚与肩同宽；表情平静中性，目视前方。',
    '· 严格还原参考图中角色的脸型五官、发型发色、瞳色、肤色、体型比例和所有标志性特征（如兽耳、尾巴、饰品），以及身上的服装与配饰；参考图里看不到的部分（背面、侧面）按同一设计合理补全，三个视图之间保持完全一致。',
    '· 纯白背景；不要场景、道具、文字、标注、尺寸线或分格框线；均匀柔和的平光，没有强烈阴影。',
    '· 保持参考图原本的画风与上色方式。',
  ],
  outfits: [
    '根据参考图中的服装，画一张服装设计三视图（fashion design sheet）。',
    '· 只展示这套服装本身：把它穿在一个没有五官和发型的浅灰色素体人台上，不要出现参考图里模特的长相、姿势或背景。',
    '· 正面、侧面、背面三个全身视图从左到右横向等距排列，大小一致、上下对齐，整套服装完整入画。',
    '· 准确还原版型、长度、颜色、图案、面料质感和所有结构细节（领口、袖口、腰线、裙摆、褶裥、纽扣拉链、蕾丝花边等），连同鞋袜和配饰；参考图看不到的背面、侧面按同一款式合理补全。',
    '· 纯白背景；不要文字、标注或分格框线；均匀柔和的光照。',
  ],
  props: [
    '根据参考图中的物品，画一张道具设计三视图（prop design sheet）。',
    '· 只画这个物品本身，去掉拿着它的手、人物和周围的杂物。',
    '· 正面、侧面、背面三个视图，再加一个 45° 斜侧透视图，从左到右横向排列，比例一致、底部对齐。',
    '· 准确还原外形结构、比例、颜色、材质质感、纹理图案和细节；看不到的部分按同一设计合理补全。',
    '· 纯白背景，只保留极淡的接触阴影；不要文字、标注或分格框线；均匀柔和的光照。',
  ],
  scenes: [
    '根据参考图中的场景，画一张场景设定图（environment design sheet），之后会在这个场景里画角色。',
    '· 去掉画面里所有的人物和动物，只保留空间本身。',
    '· 版式：上方是一张宽幅的主视角全景；下方左边是从相反方向看过去的反向视角，右边是一张俯视的平面布局示意图（简洁的线条加色块）。三格之间用细白边分隔。',
    '· 准确还原空间结构、门窗位置、主要家具和陈设、材质、配色、光线氛围与时代风格；参考图看不到的部分按同一风格合理延伸，三个视角之间的家具位置要对得上。',
    '· 不要文字和标注；保持参考图的画风。',
  ],
}

function sheetPrompt(category, description, hint) {
  const lines = [...(SHEET_PROMPTS[category] || SHEET_PROMPTS.props)]
  if (description && description.trim()) lines.push(`参考描述（帮助还原细节）：${description.replace(/\s+/g, ' ').trim()}`)
  if (hint && hint.trim()) lines.push(`补充要求（优先遵守）：${hint.trim()}`)
  return lines.join('\n')
}
const categories = {identity:'characters', outfit:'outfits', scene:'scenes', object:'props'};
function studioPromptPlan(kind, description, hint, referenceCount) {
  const category = categories[kind];
  return {
    source:'dsh-image-studio 0.5.1', aspect:SHEET_ASPECT[category], referenceCount,
    analysis:analyzePrompt(category, hint), sheet:sheetPrompt(category, description, hint),
  };
}

const reviewedShapes = {
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
    wardrobe:'<path d="m8 3-5 3-2 4 4 3 2-2v10h10V11l2 2 4-3-2-4-5-3a4 4 0 0 1-8 0Z"/>',
    camera:'<path d="M3 7h4l2-3h6l2 3h4v13H3Z"/><circle cx="12" cy="13" r="4"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="8" r="1"/>',
    book:'<path d="M5 3h15v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 14h15M8 8h8m-8 4h5"/>',
    'map-pin':'<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    'arrow-right':'<path d="M3 12h16m-6-6 6 6-6 6"/>',
    sliders:'<path d="M3 6h6m4 0h8M3 12h10m4 0h4M3 18h2m4 0h12"/><circle cx="11" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
    leaf:'<path d="M20 3c-1 7 0 14-5 17a7 7 0 0 1-9-10c3-4 8-3 14-7Z"/><path d="M4 21 16 8"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    home:'<path d="m2 11 10-8 10 8M5 9v12h14V9m-10 12v-8h6v8"/>',
    heart:'<path d="M12 21s-9-6.3-9-12a5.1 5.1 0 0 1 9-3.4A5.1 5.1 0 0 1 21 9c0 5.7-9 12-9 12Z"/>',
    moon:'<path d="M20 16A9 9 0 0 1 9 4a9 9 0 1 0 11 12Z"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v5m10-5v5M3 10h18m-13 4h4"/>',
    sparkles:'<path d="m12 3 2.4 6.5L21 12l-6.6 2.5L12 21l-2.4-6.5L3 12l6.6-2.5L12 3Z"/>',
    user:'<circle cx="12" cy="8" r="3.7"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    coffee:'<path d="M3 7h13v7a6.5 6.5 0 0 1-13 0V7Zm13 1h2a3 3 0 0 1 0 6h-2M2 22h17"/>',
    chat:'<path d="M21 11a8 8 0 0 1-8 8H9l-6 3 1.8-6A8 8 0 1 1 21 11Z"/><path d="M8 10h8m-8 4h5"/>',
    music:'<path d="M9 18V5l11-2v12M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.4"/><ellipse cx="17" cy="15" rx="3" ry="2.4"/>',
    palette:'<path d="M13 3c5 0 9 3.7 9 8 0 2-1.6 3-4 3h-2c-1.4 0-2.2 1.3-1.6 2.6.8 2-.3 4.4-3.1 4.4A8.8 8.8 0 0 1 3 12c0-5 4.5-9 10-9Z"/><path d="M7.5 10h.1m3.1-3h.1m4.5-.4h.1m2.2 2.8h.1" stroke-width="2.5"/>',
    compass:'<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5Z"/>',
    briefcase:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V4h8v3M3 13h18m-11 0v2h4v-2"/>',
    globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    chalkboard:'<path d="M3 4h18v12H3zM12 16v4m-4 1 4-2 4 2M6 8h6m-6 4h3"/>',
    backpack:'<path d="M9 5V4a3 3 0 0 1 6 0v1M4.5 12a7.5 7.5 0 0 1 15 0v8H4.5zM8 20v-6h8v6M7 11h10"/>',
    graduate:'<path d="m2 9 10-5 10 5-10 5zM6.5 12v4c3.5 3 7.5 3 11 0v-4M21 10v6"/>',
    medical:'<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-4 4v6m-3-3h6"/>',
    stethoscope:'<path d="M4 3v6a4 4 0 0 0 8 0V3M3 3h3m5 0h2M8 13v1a6 6 0 0 0 12 0v-2"/><circle cx="19" cy="9" r="2.5"/>',
    building:'<path d="M3 21h18M6 21V5l10-3v19m0-10h4v10M9 8h1m2-1h1m-4 5h1m2-1h1m-4 5h1m2-1h1"/>',
    livevideo:'<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/><circle cx="6" cy="10" r="1"/>',
    shield:'<path d="m12 2 8 4v6c0 4-3 7-8 10-5-3-8-6-8-10V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    plane:'<path d="m21 3-6 18-3-8-8-3 17-7Zm-9 10 5-6"/>',
    shrine:'<path d="M2 5q10 3 20 0M3 10h18M7 7 6 21m11-14 1 14M10 7v3m4-3v3"/>',
    film:'<path d="m3 8 17-5 1 5-17 5zM4 13h17v8H4zM7 7l3 4m2-6 3 4m2-5 3 4"/>',
    mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0m-7 7v4m-4 0h8"/>',
    headphones:'<path d="M3 13a9 9 0 0 1 18 0v5m-18-5v5"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
    gem:'<path d="M3 9 7 4h10l4 5-9 12zM3 9h18M12 21 8 9l4-5 4 5z"/>',
    pen:'<path d="m4 16 11-11 4 4L8 20l-5 1 1-5Zm9-9 4 4"/>'
  }
  const reviewedAliases={shirt:'wardrobe',bed:'moon',activity:'heart',map:'map-pin',palette:'pen',brush:'pen',notebook:'book',send:'chat',users:'user',grid:'calendar',house:'home',settings:'sliders','message-circle':'chat',cloud:'sun'}
function reviewIcon(name,size=18){
  const shape=reviewedShapes[name]||reviewedShapes[reviewedAliases[name]]||reviewedShapes.compass
  return h('svg',{'aria-hidden':true,focusable:false,width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,strokeLinecap:'round',strokeLinejoin:'round',dangerouslySetInnerHTML:{__html:shape}})
}
const reviewedPageCSS=".cp-panel{color-scheme:light;--ink:#1f2328;--text:var(--ink);--muted:#57606a;--sub:#57606a;--line:#e3e7eb;--border:var(--line);--surface:#fff;--paper:#f6f8fa;--blue:#3d7fd6;--primary:#3d7fd6;--accent:#3d7fd6;--pale:#eef4fc;--round:16px}\n.cp-panel{--cp-chevron:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='m2.5 4.25 3.5 3.5 3.5-3.5' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")}\n@scope (.cp-panel){\n:where(.lf-wrap,.rs-page,.md-page,.lf-dialog,.rs-dialog,.md-dialog) :where(h2,h3,h4,p,figure,fieldset){margin:0} img,svg{vertical-align:middle} :where(button,input,textarea,select){font:inherit;color:inherit} :where(*){box-sizing:border-box}\n:scope{display:grid;gap:18px;min-width:0}.cp-stack{display:grid;gap:16px}.cp-row,.cp-tabs,.cp-nav-end,.cp-navigation{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cp-row>h3{margin:0;flex:1}.cp-nav-end{margin-inline-start:auto}\n:scope>.cp-module-head .ab-btn{min-height:40px;line-height:20px;justify-content:center}.cp-persona-select{height:40px;width:min(160px,36vw);border-radius:10px}\n#module-save{position:relative}\n#module-save[data-pending]::after{content:\"\";position:absolute;top:4px;inset-inline-end:4px;width:6px;height:6px;border-radius:50%;background:currentColor}\n.cp-navigation a{text-decoration:none}.module-hint{color:#687b96;font-size:12px;margin:0;line-height:1.7}\n:scope .cp-switch{display:flex;align-items:center;gap:8px;height:40px;white-space:nowrap;cursor:pointer}:scope .cp-switch input{appearance:none;width:40px;height:24px;border-radius:20px;background:#dce0e5;margin:0;position:relative;cursor:pointer}:scope .cp-switch input:checked{background:#397fda}:scope .cp-switch input:after{content:'';position:absolute;width:18px;height:18px;background:white;border-radius:50%;left:3px;top:3px;transition:transform .15s}:scope .cp-switch input:checked:after{transform:translateX(16px)}\n\n\n:where(.rs-save-prefs,.rs-wardrobe,.rs-prompts,.lf-profile-ideas,.lf-web-rules,.md-tuning-fold,.md-samples,.md-explain,.rv-page details.settings-section){\n  &>summary{display:flex;align-items:center;gap:7px;min-height:32px;max-width:100%;list-style:none}\n  &>summary::-webkit-details-marker{display:none}\n  &[open]>summary::after{transform:rotate(180deg)}\n}\n:where(.rs-save-prefs,.rs-wardrobe,.rs-prompts,.lf-profile-ideas,.lf-web-rules,.md-tuning-fold,.md-samples,.md-explain,.rv-page details.settings-section)>summary::after,.md-origin::after{\n  content:\"\";display:block;width:12px;height:12px;flex:none;background-color:currentColor;mask:var(--cp-chevron) center / contain no-repeat;\n}\n:where(.rs-save-prefs,.rs-wardrobe)>summary::after{margin-inline-start:auto}\n.btn,.chip{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:5px 12px;border:1px solid var(--line);border-radius:8px;background:white;line-height:1.45;font-size:13px}.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}.btn:hover:not(:disabled),.chip:hover:not(:disabled){filter:brightness(.97)}.chip{min-height:26px;padding:2px 9px;font-size:12px}\n.card{border:1px solid var(--line);border-radius:var(--round);background:var(--surface)}.muted,.eyebrow{color:var(--muted)}[hidden]{display:none!important}\n\n@media(max-width:640px){:scope>.cp-module-head{padding:14px}.cp-nav-end{margin:0;width:100%}.cp-persona-select{flex:1;min-width:0}.cp-tabs,.cp-navigation,.cp-nav-end{gap:5px}.cp-module-head .ab-btn{padding-inline:9px;min-height:36px}}\n:scope>.cp-module-head .module-options{border-color:transparent;background:transparent;color:var(--ab-sub);padding:4px 9px}\n:scope>.cp-module-head .module-options:hover{background:var(--ab-card-2)}\n.cp-persona-select{width:min(148px,36vw)}\n.module-field{display:grid;gap:4px;margin:17px 0;color:#242d39;font-weight:600}\n.module-field input,.module-field select{border:1px solid #d7dee8;border-radius:8px;padding:7px 10px;background:#fff}\n.module-field small,.option-hint{font-size:12px;font-weight:400;color:#596a7d}\n@media(max-width:385px){.cp-row{gap:4px}:scope>.cp-module-head .module-options{padding:4px}:scope>.cp-module-head .cp-row>.primary{padding-inline:7px}}\n\n.cp-row>h3{white-space:nowrap}\n@media(max-width:450px){.cp-row{gap:4px}:scope>.cp-module-head .cp-row .ab-btn{padding-inline:7px}.cp-switch{gap:4px!important}}\n@media(max-width:365px){.cp-row{display:grid;grid-template-columns:1fr auto auto}.cp-row>h3,.cp-row>.cp-switch,.cp-row>#module-save{grid-row:1}.cp-row>.module-options{grid-column:1/-1;justify-self:start;min-height:26px!important}}\n\n:scope .cp-navigation{display:flex;align-items:center;flex-wrap:wrap;gap:8px}\n:scope .cp-module-head .cp-row{gap:8px}\n:scope .cp-module-head .cp-row>h3{min-width:0;line-height:1.4}\n.cp-module-head>p{margin:0}.cp-module-head .cp-switch input{flex:0 0 40px}\n@media(max-width:640px){\n :scope .cp-module-head .cp-navigation,:scope .cp-module-head .cp-nav-end{gap:5px}\n :scope>.cp-module-head .ab-btn{min-height:36px;padding-inline:9px}\n}\n@media(max-width:450px){:scope .cp-module-head .cp-row{gap:4px}:scope>.cp-module-head .cp-row .ab-btn{padding-inline:7px}}\n\ndialog.md-dialog:has(>.cp-options-form){width:min(460px,calc(100% - 28px));scrollbar-width:thin}.cp-options-form details{padding-block:7px}.cp-options-form .option-hint{margin-top:14px}\n.lf-wrap,.lf-modal{--lf-ink:var(--ab-text,#283346);--lf-muted:#657384;--lf-line:#e2e7ed;--lf-blue:var(--ab-sea,#3d7fd6);color:var(--lf-ink)}\n.lf-wrap{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-width:0;font:inherit}\n.lf-wrap p,.lf-wrap h2,.lf-wrap h3,.lf-modal h3,.lf-modal h4{margin:0}\n.lf-wrap button,.lf-modal button{font-family:inherit}\n.lf-wrap :focus-visible,.lf-modal :focus-visible{outline:2px solid var(--lf-blue);outline-offset:2px}\n.lf-top,.lf-heading,.lf-now,.lf-life-actions,.lf-hero-buttons,.lf-progress-label,.lf-modal-head,.lf-modal-footer,.lf-demo-doors,.lf-preview-title{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.lf-top,.lf-life-actions,.lf-hero-buttons,.lf-demo-doors,.lf-preview-title{flex-wrap:wrap}\n.lf-title,.lf-heading h3,.lf-set-icon,.lf-mark,.lf-head-icon,.lf-occupation-icon{display:inline-flex;align-items:center;gap:7px}\n.lf-life-heading,.lf-active-preset{display:flex;align-items:center;gap:8px}.lf-active-preset{gap:5px;padding:2px 8px;border:0;border-radius:99px;background:#f0f4fa;color:#52697f;font-size:12px}.lf-active-preset .lf-occupation-icon{width:17px;height:20px;font-size:14px}.lf-title{font-size:15px;font-weight:650}.lf-title::before{content:\"\";width:4px;height:15px;border-radius:3px;background:linear-gradient(var(--ab-sky),var(--lf-blue))}\n.lf-top{align-items:flex-start;flex-wrap:nowrap}.lf-life-heading{min-width:0;min-height:30px;flex-wrap:wrap;row-gap:4px}.lf-title,.lf-life-actions{flex:none}\n.lf-relation{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;min-width:0;font-size:12px;line-height:20px;color:var(--lf-muted)}\n.lf-relation>span{white-space:nowrap}.lf-relation strong{color:var(--lf-ink);font-weight:600;font-variant-numeric:tabular-nums}\n.lf-relation>.lf-relation-stage{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;color:#89546d;white-space:normal;overflow-wrap:anywhere}.lf-relation-stage svg{flex:none}\n@media(max-width:540px){\n .lf-top{display:grid;grid-template-columns:fit-content(38%) minmax(0,1fr) auto;align-items:center;row-gap:4px}\n .lf-life-heading{display:contents}.lf-title{grid-area:1/1}.lf-top .lf-active-preset{grid-area:2/1;max-width:100%;justify-self:start}\n .lf-relation{grid-area:2/2/3/-1}.lf-life-actions{grid-area:1/3}\n}\n.lf-active-preset{min-width:0;max-width:34ch;min-height:28px;line-height:18px}\n.lf-preset-name{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}\n.lf-preset-chevron{display:block;flex:none;color:#677f95}\n.lf-life-actions{justify-content:flex-start}.lf-wrap .btn{min-height:30px;font-size:12px}\n.lf-link{border:0;border-radius:6px;background:transparent;padding:5px 7px;font-size:12px;color:#366cad}.lf-link:hover{background:#edf4ff}\n.lf-first-grid,.lf-main-grid{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(0,1fr);gap:14px;align-items:stretch}\n.lf-side{display:grid;grid-template-rows:auto 1fr;align-content:start;gap:14px;min-width:0}\n.lf-wrap .card{--tone:#387ed1;--wash:#edf4fd;min-width:0;position:relative;padding:17px 19px;border:1px solid var(--ab-line,#e4e7eb);border-radius:var(--ab-radius,16px);background:linear-gradient(145deg,color-mix(in srgb,var(--wash) 71%,white),white 62%);box-shadow:var(--ab-shadow,0 2px 8px #1c32520b)}\n.lf-wrap .lf-next{--tone:#9d6a22;--wash:#fff3dc}.lf-wrap .lf-chron{--tone:#288174;--wash:#e6f4ee}.lf-wrap .lf-mind{--tone:#8e65af;--wash:#f3edf8}.lf-wrap .lf-today{--tone:#50779d;--wash:#eaf2fa}\n.lf-head-icon,.lf-mark,.lf-occupation-icon,.lf-set-icon{justify-content:center;flex:none}.lf-head-icon{width:28px;height:28px;border-radius:8px;color:var(--tone);background:var(--wash)}\n.lf-heading{margin-bottom:12px}.lf-heading h3{font-size:15px;line-height:1.5;font-weight:650;gap:8px}\n.lf-secondary,.lf-help,.lf-progress-label,.lf-scene-bind,.lf-destinations small,.lf-thought small,.lf-history-meta,.lf-history time small,.lf-recent-item time,.lf-demo-doors,.lf-preset-detail small,.lf-modal-head small{color:var(--lf-muted);font-size:12px;line-height:1.6}\n.lf-livetag{display:inline-flex;align-items:center;gap:5px;border-radius:99px;background:#e9f5ef;color:#367b55;font-size:11px;padding:2px 8px}.lf-livetag i{height:6px;width:6px;background:#4ba978;border-radius:50%}\n.lf-now{justify-content:flex-start;margin:0 0 11px}.lf-now h2{font-size:19px;font-weight:650;line-height:1.45}.lf-now p{font-size:12px;margin:3px 0 0;color:var(--lf-muted)}.lf-now time{margin-left:auto;font-size:16px;font-weight:600;color:#456587;font-variant-numeric:tabular-nums}\n.lf-now>div{min-width:0;overflow-wrap:anywhere}.lf-now time{flex:none}\n.lf-hero progress{width:100%;height:5px;display:block;border:0;border-radius:8px;overflow:hidden;margin:5px 0 12px;appearance:none;background:#e6eef6}.lf-hero progress::-webkit-progress-bar{background:#e6eef6}.lf-hero progress::-webkit-progress-value{background:#659bea;border-radius:8px}.lf-hero progress::-moz-progress-bar{background:#659bea}\n.lf-hero-buttons{justify-content:flex-start}.lf-hero-buttons .lf-link{margin-left:auto}\n.lf-scene-bind,.lf-destinations{display:grid;gap:7px;margin-top:12px}.lf-scene-bind img{width:112px;height:70px;object-fit:contain}.lf-scene-bind select{max-width:100%;margin-left:6px;font:inherit}.lf-destinations>div{display:flex;flex-wrap:wrap;gap:4px}.lf-place{border:0;background:#eaf2fb;color:#396594;padding:4px 8px;border-radius:5px;font-size:12px}\n.lf-agenda{display:grid;gap:6px}.lf-agenda>div{display:grid;grid-template-columns:45px 1fr;gap:10px;align-items:baseline;padding:6px 0}.lf-agenda time,.lf-recent-item time,.lf-history time{font-variant-numeric:tabular-nums}.lf-agenda time{font-size:13px;color:#89642e;font-weight:600}.lf-agenda p,.lf-recent-item strong{font-size:13px;line-height:1.6}\n.lf-filter{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:11px}.lf-filter button{padding:3px 7px;border:0;background:transparent;border-radius:6px;font:inherit;font-size:12px;color:var(--lf-muted)}.lf-filter button[aria-pressed=true]{color:#216e60;background:#def0e8;font-weight:600}.lf-filter button:hover{background:#edf3f1}\n.lf-history{list-style:none;margin:0;padding:0}.lf-history-row{display:grid;grid-template-columns:52px 14px minmax(0,1fr);column-gap:9px;position:relative}\n.lf-chron{display:flex;flex-direction:column}\n.lf-history-pager{display:flex;align-items:center;justify-content:space-between;gap:4px;flex-wrap:wrap;margin-top:auto;padding-top:14px;color:var(--lf-muted);font-size:12px}\n.lf-history-pager button,.lf-history-pager input{min-height:30px;border:1px solid var(--ab-line-2);border-radius:7px;background:#fff;font:inherit;color:inherit}\n.lf-history-pager button{padding:3px 9px;color:#346e60}.lf-history-pager button:disabled{color:#7f8e89}\n.lf-history-pager label{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}\n.lf-history-pager input{width:5ch;min-width:34px;padding:2px;text-align:center;font-variant-numeric:tabular-nums;appearance:textfield}\n.lf-history-pager input::-webkit-inner-spin-button{appearance:none}\n.lf-history-row>time,.lf-history-row>div{padding:0 0 12px}.lf-history-row:last-child>time,.lf-history-row:last-child>div{padding-bottom:0}.lf-history time{display:block;text-align:right;font-size:13px;font-weight:600;color:#486258;line-height:21px;white-space:nowrap}.lf-history time small{display:block;font-size:11px;font-weight:400}\n.lf-axis{position:relative;align-self:stretch;display:flex;justify-content:center}.lf-axis::before{position:absolute;content:\"\";width:2px;top:0;bottom:0;background:#d7e9e1}.lf-history-row:first-child .lf-axis::before{top:10px}.lf-history-row:last-child .lf-axis::before{bottom:calc(100% - 11px)}.lf-axis i{position:relative;margin-top:7px;width:7px;height:7px;border-radius:50%;background:#77ad97;box-shadow:0 0 0 3px #eff8f3}\n.lf-history-row button{display:block;border:0;background:transparent;padding:0;font:inherit;font-size:13px;font-weight:600;text-align:left;line-height:21px;color:#2e413b}.lf-history-row button:hover,.lf-thought button:hover strong{text-decoration:underline;text-underline-offset:2px}.lf-history-meta{display:block;font-size:11px}.lf-history-row p,.lf-thought-body{font-size:12px;line-height:1.6;margin-top:4px;color:#556773}\n.lf-thought>button{border:0;background:transparent;width:100%;display:flex;align-items:center;gap:9px;padding:7px 0;text-align:left;color:inherit}.lf-thought small,.lf-thought strong{display:block}.lf-thought small{font-size:11px}.lf-thought strong{font-size:13px;font-weight:550}.lf-mark{width:29px;height:29px;border-radius:8px;color:#9b6988;background:#faedf5}.t1 .lf-mark{color:#8c74ad;background:#f2eef8}.t2 .lf-mark{color:#508672;background:#eaf4ee}.lf-chevron{margin-left:auto;font-size:12px;color:#82929f}.lf-thought-body{margin:0 0 4px 38px}.lf-mood-footer{display:flex;align-items:center;gap:6px;margin-top:9px;font-size:11px;color:var(--lf-muted)}\n.lf-recent-item{display:grid;grid-template-columns:73px 1fr;align-items:baseline;gap:9px;padding:8px 0}.lf-recent-item time{font-size:11px}.lf-recent-item strong{font-weight:550}.lf-today>.lf-link{padding-left:0;margin-top:7px}\n.lf-source-note,.lf-test,.lf-toast,.lf-manual{background:#eef5fb;color:#365a83;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.6}\n.lf-modal{width:min(684px,calc(100% - 24px));max-height:86vh;max-height:86dvh;padding:0;border:1px solid var(--lf-line);border-radius:16px;background:white;box-shadow:0 16px 50px #20315133;margin:auto}\n.lf-modal[open]{display:flex;flex-direction:column}.lf-modal::backdrop{background:#202c3b65}.lf-modal h3{font-size:17px;margin:0}.lf-modal-head,.lf-modal-footer{padding:15px 20px;flex:none}.lf-modal-head{border-bottom:1px solid var(--lf-line)}.lf-modal-footer{border-top:1px solid var(--lf-line);justify-content:flex-end;flex-wrap:wrap}.lf-modal-scroll>.lf-modal-footer{margin:12px 0 0;padding:12px 0 0}\n/* The settings dialog follows the host's compact controls and tab spacing. */\n.lf-form-error{flex:1 1 200px;margin:0;color:#a43736;font-size:12px;line-height:18px}\n.lf-commit-hint{flex:1;min-width:0;color:#596a7d;font-size:12px;line-height:18px}\n.lf-modal h3:focus-visible{outline:none}\n.lf-modal-scroll{min-height:0;overflow:auto;padding:18px 20px;overscroll-behavior:contain}\n.lf-config{display:inline-flex;align-items:center;gap:6px}\n.lf-settings-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}\n.lf-setting-card{\n  display:grid;grid-template-columns:30px minmax(0,1fr);grid-template-rows:22px auto;\n  align-content:start;align-items:center;gap:2px 9px;min-width:0;min-height:80px;\n  padding:13px 10px;text-align:left;line-height:1.45;border:1px solid var(--lf-line);\n  border-radius:10px;background:var(--ab-card,#fff);color:inherit;\n}\n.lf-setting-card:hover{background:var(--ab-hover,#f6f9fc);border-color:#a3bfdf}\n.lf-set-icon{align-self:start;grid-row:span 2;width:30px;height:30px;border-radius:8px;background:#edf4ff;color:#386da8}\n.lf-setting-card[data-life-arg=space] .lf-set-icon{background:#edf5ef;color:#447754}\n.lf-setting-card[data-life-arg=body] .lf-set-icon{background:#fbeff2;color:#9c5070}\n.lf-setting-card[data-life-arg=auto] .lf-set-icon{background:#e8f4f1;color:#347a68}\n.lf-setting-card[data-life-arg=social] .lf-set-icon{background:#fbf3e3;color:#8b672a}\n.lf-setting-card[data-life-arg=meeting] .lf-set-icon{background:#f2eef9;color:#775c9e}\n.lf-setting-card strong{font-size:14px;font-weight:600}\n.lf-setting-card small{font-size:12px;color:var(--lf-muted);line-height:1.45}\n.lf-subheading{display:grid;gap:3px;justify-items:start}\n.lf-back{display:inline-flex;align-items:center;gap:3px;margin-left:-3px;padding:2px 3px;color:#366cad;background:transparent;border:0;border-radius:4px;font-size:12px;line-height:18px}\n.lf-back:hover,.lf-link:hover{background:#edf4ff}\n.lf-demo-doors{margin-top:14px;padding:7px 2px 0}\n.lf-settings-sub{display:grid;gap:19px;min-width:0}\n.lf-form-group{min-width:0;margin:0;padding:0;border:0}\n.lf-form-group legend{margin:0 0 9px;padding:0;color:var(--lf-ink);font-size:14px;line-height:20px;font-weight:650}\n.lf-form-group legend small{margin-left:4px;color:var(--lf-muted);font-size:12px;font-weight:400}\n.lf-form-grid,.lf-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:end;gap:10px 16px}\n.lf-full{grid-column:1/-1}\n.lf-net-help,.lf-net-status{margin:0;color:var(--lf-muted);font-size:12px;line-height:1.55}\n.lf-net-status{padding-top:8px;border-top:1px solid var(--lf-line)}\n.lf-web-example{padding:12px 14px;background:#f3f7fb;border-radius:9px}\n.lf-web-example .lf-field{max-width:320px}\n.lf-web-rules{font-size:13px;color:var(--lf-muted)}\n.lf-web-rules summary{cursor:pointer;width:fit-content;padding:4px 0}\n.lf-web-rules[open] summary{margin-bottom:8px}\n.lf-web-example dl{display:grid;gap:6px;margin:12px 0 0;font-size:13px}\n.lf-web-example dl div{display:grid;grid-template-columns:3em minmax(0,1fr);gap:6px}\n.lf-web-example dt{color:var(--lf-muted)}.lf-web-example dd{margin:0;overflow-wrap:anywhere}\n.lf-measure-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}\n.lf-field{min-width:0;display:grid;gap:5px;color:var(--lf-ink);font-size:12px;line-height:18px}\n.lf-field :is(input,select,textarea),.lf-scene-bind select{\n  box-sizing:border-box;min-width:0;width:100%;padding:7px 9px;\n  border:1px solid var(--ab-line-2,#d6dde4);border-radius:8px;background:#fff;\n  font:inherit;font-size:13px;line-height:20px;color:inherit;\n}\n.lf-field :is(input,select){height:36px}\n.lf-field textarea{display:block;height:62px;min-height:54px;resize:vertical}\n.lf-scene-bind select{width:auto}\n.lf-switches,.lf-meet-choices{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}\n.lf-meeting-input{display:grid;grid-template-columns:minmax(100px,1fr) minmax(160px,2.7fr) auto;align-items:end;gap:10px}\n.lf-meeting-input .btn{min-height:36px}\n.lf-meeting-manual,.lf-meeting-manual div{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.lf-meeting-manual>span{font-size:12px;color:var(--lf-muted)}\n.lf-meeting-manual .btn[aria-pressed=true]{background:var(--ab-hover,#edf3fa);border-color:var(--lf-blue);color:var(--lf-blue)}\n@media(max-width:520px){.lf-meeting-input{grid-template-columns:minmax(0,1fr) auto}.lf-meeting-input .lf-field:first-child{grid-column:1/-1;max-width:150px}}\n.lf-switch{display:flex;align-items:center;gap:7px;min-width:0;min-height:36px;font-size:13px;line-height:18px;cursor:pointer}\n.lf-switch input,.lf-upgrades input{width:16px;height:16px;flex:none;margin:0;accent-color:var(--lf-blue)}\n.lf-switch input{order:-1}\n.lf-settings-sub>:is(.btn,.lf-link){justify-self:start}\n.lf-preset-stories{display:grid;grid-template-columns:1.25fr 1fr;gap:10px;margin-top:12px}\n.lf-work-story,.lf-off-duty{min-width:0;padding:12px;border-radius:9px;background:#fff}\n.lf-work-story>div{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:3px}\n.lf-work-story>div>strong,.lf-off-duty>strong{font-size:12px;color:#76572e}\n.lf-off-duty>strong{color:#42736a}\n.lf-work-story b{font-size:13px;font-weight:600}\n.lf-profile-ideas summary{width:fit-content;cursor:pointer;color:#386b9d}\n.lf-idea-row{display:grid;grid-template-columns:4.5em minmax(0,1fr);gap:7px;margin-top:9px;font-size:12px;align-items:baseline}\n.lf-idea-row>div{display:flex;flex-wrap:wrap;gap:5px}\n.lf-chip-idea{font:inherit;line-height:1.5;text-align:left;color:#356557;min-height:28px;background:#f0f6f3;border:1px solid #d5e4dc;border-radius:6px;padding:4px 8px;cursor:pointer}\n.lf-chip-idea:disabled{opacity:.55;cursor:default}\n@media(max-width:560px){.lf-preset-stories,.lf-idea-row{grid-template-columns:minmax(0,1fr)}.lf-preset-stories{gap:7px}}\n.lf-preset-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:13px 0}.lf-preset-grid button{display:flex;align-items:center;gap:8px;text-align:left;min-width:0;padding:6px 8px;min-height:43px;border:1px solid var(--lf-line);border-radius:9px;background:white;color:inherit;font-size:13px}.lf-preset-grid button[aria-pressed=true]{background:#eef5ff;border-color:#8eb1e5;color:#245c9f}.lf-occupation-icon{width:28px;height:28px;flex:none;border-radius:8px;background:#eaf2ff;color:#3a6bb1}\n.lf-occupation-icon.tone-rose{background:#f9eef2;color:#a45170}.lf-occupation-icon.tone-amber{background:#fbf1df;color:#95611d}\n.lf-occupation-icon.tone-teal{background:#e8f4ee;color:#39816b}.lf-occupation-icon.tone-indigo{background:#f1edfa;color:#7157a0}\n.lf-active-preset .lf-occupation-icon{background:transparent}.lf-active-preset .lf-occupation-icon svg{width:14px;height:14px}\n.lf-preset-detail{padding:12px 15px;border-radius:9px;background:#f3f7fb}.lf-preset-detail p{margin:5px 0;font-size:13px}.lf-preset-detail .lf-filter{margin:6px 0}.lf-upgrades{display:grid;gap:8px;margin:13px 0}.lf-upgrades label{display:flex;align-items:flex-start;gap:9px;padding:10px;background:#f5f8fb;border-radius:8px}.lf-upgrades span>*{display:block}.lf-upgrades small{font-size:12px;margin:4px 0;color:var(--lf-muted)}.lf-upgrades b{font-size:13px;font-weight:550}\n@media(max-width:730px){.lf-first-grid,.lf-main-grid{grid-template-columns:minmax(0,1fr)}.lf-first-grid,.lf-main-grid,.lf-side,.lf-wrap{gap:11px}.lf-wrap .card{padding:14px 15px}.lf-preset-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.lf-modal-scroll,.lf-modal-head,.lf-modal-footer{padding:13px}}\n@media(max-width:600px){\n  .lf-settings-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .lf-measure-grid{grid-template-columns:repeat(3,minmax(0,1fr))}\n}\n@media(max-width:480px){\n  .lf-now h2{font-size:17px}\n  .lf-history-row{grid-template-columns:46px 10px minmax(0,1fr);column-gap:8px}\n  .lf-preset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .lf-settings-tiles{gap:8px}\n  .lf-setting-card{grid-template-columns:26px minmax(0,1fr);grid-template-rows:auto auto;align-items:start;align-content:start;gap:5px 6px;min-height:0;padding:10px}\n  .lf-set-icon{width:26px;height:26px;grid-row:auto}\n  .lf-setting-card strong{align-self:center;font-size:13px}\n  .lf-setting-card small{grid-column:1/-1}\n  .lf-form-grid,.lf-field-grid{column-gap:10px}\n  .lf-note-field{grid-column:1/-1}\n  .lf-switches{column-gap:12px}\n}\n@media(max-width:370px){\n  .lf-measure-grid{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .lf-switch{font-size:12px}\n}\n.lf-context-example{display:grid;gap:4px;margin-top:4px;padding:10px 12px;border-radius:8px;background:var(--lf-wash,#eff5fb);font-size:13px}\n.lf-context-example small{color:var(--lf-muted);line-height:1.6}\n\n.rs-page {\n  --rs-ink:#273348;\n  --rs-muted:#66748c;\n  --rs-line:#e3e7ed;\n  --rs-blue:#397ad3;\n  display:grid;\n  gap:12px;\n  font:inherit;\n  color:var(--rs-ink);\n}\n.rs-page *, .rs-page *::before, .rs-page *::after {box-sizing:border-box}\n.rs-page [hidden]{display:none!important}\n.rs-page :is(h1,h2,h3,h4,p,figure){margin:0}\n.rs-page .page-head {margin:0;display:block}\n#content .rs-page .page-head h1,.rs-page .page-head h1 {font-family:inherit;font-size:15px;line-height:1.55;font-weight:600;letter-spacing:normal}\n.rs-page .page-head h1,.rs-page h2,.rs-page h3 {display:flex;align-items:center;gap:8px}\n.rs-page .page-head h1::before,.rs-page h2::before {content:'';width:3px;flex:none;height:14px;border-radius:3px;background:var(--rs-blue)}\n.rs-page .page-head>.rs-link {flex:none}\n.rs-page :is(.page-head,.rs-studio-head,.rs-review-head) p {margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--rs-muted)}\n.rs-collections {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:3px 0 4px}\n.rs-collections button {--tint:#e8f0fe;--tone:#3768bd;display:flex;align-items:center;text-align:left;gap:10px;min-width:0;min-height:54px;border:1px solid transparent;border-radius:11px;background:#f6f8fb;font:inherit;font-size:14px;color:#353d49;padding:8px 12px;transition:background .12s,border-color .12s}\n.rs-collections [data-role-kind=outfit] {--tint:#f3ebf9;--tone:#8966a6}\n.rs-collections [data-role-kind=scene] {--tint:#e5f2ed;--tone:#39796b}\n.rs-collections [data-role-kind=object] {--tint:#f9edda;--tone:#98713a}\n.rs-collections button svg {box-sizing:content-box;padding:7px;background:var(--tint);color:var(--tone);border-radius:9px;flex:none}\n.rs-collections button strong {font-weight:600}\n.rs-collections button:hover {background:var(--tint)}\n.rs-collections button[aria-pressed=true] {color:var(--ab-deep,#203f72);background:#eff5ff;border-color:#a9c7f1}\n.rs-count {margin-left:auto;line-height:1;font-size:12px;font-variant-numeric:tabular-nums;color:#697585}\n.rs-page .btn.primary {background:var(--ab-sea,#3979cd);color:white;border-color:var(--ab-sea,#3979cd)}\n.rs-page .card {padding:0;min-width:0;background:white;border:0;border-radius:12px;box-shadow:none}\n.rs-studio-head,.rs-review-head,.rs-library-head {display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}\n.rs-studio-head {padding:4px 0 9px}.rs-studio-head>small {font-size:12px;color:var(--rs-muted)}\n.rs-studio-head>h2 {flex:1 0 max-content;max-inline-size:100%}\n.rs-page h2 {font-family:inherit;font-size:15px;font-weight:600;line-height:1.5}\n.rs-page h3,.rs-page h4 {font-family:inherit;font-size:14px;line-height:1.5;font-weight:600}\n.rs-workbench {display:grid;grid-template-columns:minmax(210px,.8fr) minmax(0,1.45fr);gap:16px;background:#f6f8fa;padding:14px;border-radius:12px}\n.rs-intake {min-width:0;display:flex;flex-direction:column;gap:8px;padding:0}\n.rs-seeds {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;min-width:0}\n.rs-seeds:empty {display:none}\n.rs-seeds figure {min-width:0;border-radius:9px;background:#fff}\n.rs-seeds figure:only-child {grid-column:1/-1}\n.rs-seeds img {width:100%;height:88px;display:block;object-fit:contain;padding:3px}\n.rs-seeds figure:only-child img {height:123px}\n.rs-seeds figcaption {display:flex;align-items:center;gap:6px;padding:2px 8px 4px;min-width:0;color:var(--rs-muted);font-size:12px}\n.rs-seeds figcaption span {flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.rs-seeds figcaption button {flex:none;min-height:32px;padding:4px 6px;border:0;border-radius:5px;background:transparent;color:#456485;font:inherit}\n.rs-seeds figcaption button:hover {background:#eff4fa}\n.rs-page [data-role-filter] {appearance:none}\n.rs-page [data-role-filter]::-webkit-search-cancel-button {display:none;-webkit-appearance:none}\n.rs-drop {position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-content:center;align-items:center;gap:4px 10px;background:#fafcff;border:1px dashed #aec7e6;border-radius:8px;color:#265eaa;padding:13px;cursor:pointer}\n.rs-seeds:empty+.rs-drop {flex:1;min-height:104px}\n.rs-drop>svg {grid-row:span 2}\n.rs-drop>b {font-size:13px;font-weight:600}\n.rs-drop>small {font-size:11px;color:var(--rs-muted)}\n.rs-drop>input {position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}\n.rs-page .btn {min-height:38px;padding:5px 11px;border-radius:7px;font:inherit;font-size:13px;font-weight:500}\n.rs-tools:empty{display:none}\n.rs-tools {display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--rs-muted)}\n.rs-page .rs-link {background:transparent;border:0;color:#2466ac;font:inherit;font-size:12px;cursor:pointer;padding:3px 0}\n.rs-page .rs-link:hover {text-decoration:underline}\n.rs-sheet {display:flex;flex-direction:column;gap:8px;padding:11px 14px;background:white;border-radius:10px;min-width:0}\n.rs-sheet-label {display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px}\n.rs-sheet-label span {font-size:11px;color:var(--rs-muted)}\n.rs-board {display:grid;place-items:center;flex:1;min-height:145px;height:clamp(152px,19vw,219px);width:100%;background:white;border-radius:7px;overflow:hidden}\n.rs-board img {display:block;width:100%;height:100%;max-height:219px;object-fit:contain}\n.rs-board[data-sheet-state=pending] {background:#f6f8fb}\n.rs-board-empty {display:grid;place-items:center;gap:5px;text-align:center;color:var(--rs-muted);padding:12px}\n.rs-board-empty svg {color:#8091a9;margin-bottom:4px}.rs-board-empty b {font-size:13px;font-weight:560}.rs-board-empty small,.rs-thumb-empty {font-size:12px;color:var(--rs-muted)}\n.rs-page .rs-hint {font-size:12px;color:var(--rs-muted);line-height:1.55}\n.rs-review {display:grid;gap:16px;padding:22px 0 4px}\n.rs-review-head {align-items:end;flex-wrap:nowrap}\n.rs-review-head>div:first-child {min-width:0}\n.rs-review-head>.rs-field {flex:0 1 156px}\n.rs-fields,.rs-target,.rs-occasion-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;align-items:start}\n.rs-field {min-width:0;display:grid;grid-template-rows:auto auto;gap:5px;align-content:start}\n.rs-full {grid-column:1 / -1}\n.rs-field-label {min-height:24px;display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:13px;line-height:1.4;font-weight:550;color:#3c495d}\n.rs-page :where(input:not([type=checkbox]):not([type=file]),select,textarea) {display:block;box-sizing:border-box;width:100%;min-width:0;height:38px;min-height:38px;margin:0;border:1px solid #ced7e3;border-radius:7px;background-color:white;font:inherit;font-size:13px;line-height:1.45;color:var(--rs-ink);padding:7px 10px}\n.rs-page select {padding-right:26px;text-overflow:ellipsis;cursor:pointer}\n.rs-page select:disabled {background:#f1f3f6;color:#66748c}\n.rs-page textarea {height:78px;min-height:78px;resize:vertical}\n.rs-page :is(input,textarea)::placeholder {color:#728197}\n.rs-check {display:inline-flex;align-items:center;gap:6px;min-height:24px;flex:none;cursor:pointer;font-weight:400;font-size:12px;line-height:1.4;color:#516079}\n.rs-check input {flex:none;width:15px;height:15px;min-height:0;margin:0;accent-color:var(--rs-blue)}\n.rs-revise {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px 12px}\n.rs-revise>.btn,.rs-save-actions>.btn {height:38px}\n.rs-adopt {background:#f5f8fc;border-radius:10px;padding:0 14px}\n.rs-save-actions {display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 0 12px}\n.rs-save-prefs>summary,.rs-wardrobe>summary {display:flex;align-items:center;gap:9px;min-height:44px;padding:8px 0;color:#364965;cursor:pointer;list-style:none}\n.rs-page details>summary strong {font-size:13px;font-weight:600}\n.rs-page details>summary small {min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;color:var(--rs-muted)}\n.rs-target {padding:2px 0 16px}\n.rs-library,.rs-editor {padding:12px 0 2px!important}.rs-editor {border-top:1px solid var(--rs-line)!important}.rs-library-head h2:before {display:none}\n.rs-library-head>div {display:flex;align-items:baseline;gap:8px}\n.rs-library-head small,.rs-empty {font-size:12px;color:var(--rs-muted)}\n.rs-library-head input {max-width:210px}\n.rs-items {margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(232px,100%),1fr));gap:10px}\n.rs-item {display:flex;gap:10px;align-items:center;background:#f6f8fa;border-radius:8px;padding:8px;min-width:0}\n.rs-thumb {background:#fafbfc;border-radius:5px;overflow:hidden;display:grid;place-items:center;width:64px;height:64px;flex-shrink:0}\n.rs-thumb img {width:100%;height:100%;object-fit:contain}\n.rs-item>div:last-child {min-width:0}\n.rs-item p {font-size:12px;color:var(--rs-muted);line-height:1.5}\n.rs-item-actions {display:flex;gap:10px}.rs-item h4 small{display:inline-block;vertical-align:middle;margin-left:6px;background:#e6f0fe;color:#3469ac;padding:2px 6px;border-radius:5px;font-size:10px;font-weight:500}\n.rs-occasion-grid {grid-template-columns:repeat(auto-fit,minmax(min(100%,195px),1fr));gap:12px 16px;padding:0 14px 14px}\n.rs-page .rs-wardrobe {background:#f7f5fa}\n.rs-wardrobe>summary {padding:9px 14px}\n.rs-page .rs-message {padding:8px 12px;border-radius:6px;background:#eef4fd;color:#345887;font-size:12px}\n.rs-drop:focus-within,.rs-page :focus-visible {outline:2px solid #4c91e4;outline-offset:2px}\n.rs-editor,.rs-originals {display:grid;gap:10px}\n.rs-originals {grid-template-columns:repeat(auto-fill,minmax(85px,105px))}\n.rs-originals button {min-width:0;border:1px solid var(--rs-line);border-radius:6px;background:white;padding:5px;color:#2665aa;font:inherit;font-size:12px}\n.rs-originals img {width:100%;height:62px;object-fit:contain;display:block}\n.rs-lightbox {max-width:95vw;max-height:95vh;padding:12px;border:0;border-radius:9px;background:white;color:#25354b}\n.rs-lightbox::backdrop {background:rgba(28,36,47,.66)}\n.rs-lightbox img {max-width:85vw;max-height:76vh;object-fit:contain;display:block}\n.rs-lightbox button {display:block;margin:0 0 8px auto;min-height:34px;font:inherit;border:1px solid #d5dbe4;border-radius:5px;background:white;cursor:pointer}\n@media(max-width:660px) {\n  .rs-page {gap:10px}\n  .rs-collections {grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}\n  .rs-collections button {min-height:40px;padding:5px 8px;gap:6px;font-size:13px}.rs-collections button svg{width:17px;height:17px;padding:5px}\n  .rs-workbench {grid-template-columns:minmax(0,1fr)}\n  .rs-workbench {padding:10px;gap:12px}\n  .rs-seeds figure:only-child img {height:98px}\n  .rs-seeds figcaption button {min-height:44px}\n  .rs-board {height:clamp(140px,47vw,210px)}\n  .rs-fields {grid-template-columns:minmax(0,1fr)}\n  .rs-page :is(input:not([type=checkbox]):not([type=file]),select) {height:44px;min-height:44px}\n  .rs-page .btn,.rs-collections button {min-height:44px}\n  .rs-fields,.rs-target,.rs-occasion-grid {grid-template-columns:minmax(0,1fr);gap:10px}\n  .rs-revise {grid-template-columns:minmax(0,1fr);justify-items:start}\n  .rs-revise .rs-field,.rs-library-head input {width:100%;max-width:none}\n  .rs-review-head {flex-wrap:wrap}\n  .rs-review-head>.rs-field {flex-basis:100%}\n  .rs-save-actions {flex-wrap:wrap}\n  .rs-check {min-height:28px}\n  .rs-page .rs-link {min-height:32px}\n  .rs-intake{padding:0}.rs-sheet{padding:10px}.rs-review{padding:14px 0 4px}.rs-studio-head{padding:4px 0 8px}\n  .rs-library,.rs-editor {padding:12px 0!important}\n}\n\n.rs-prompts {margin:8px 0 2px;color:#475972}\n.rs-prompts>summary {font-size:13px;cursor:pointer;padding:6px 0;width:fit-content;color:#365778}\n.rs-prompts>p {margin:4px 0 10px;font-size:12px}\n.rs-prompts>h4 {margin:8px 0 4px;font-size:13px}\n.rs-prompts>pre {margin:0 0 10px;padding:10px 12px;background:#f5f7fa;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:12px;line-height:1.65}\n\n.md-page,.md-dialog{--md-line:var(--ab-line,#e5e8ed);--md-muted:var(--ab-sub,#5d6977);--md-blue:var(--ab-sea,#397bd5);color:var(--ab-text,#1c2430);font:inherit;font-size:14px;line-height:1.5}\n.md-page{width:100%;max-width:100%;min-width:0;background:var(--ab-card,#fff);border:1px solid var(--md-line);border-radius:var(--ab-radius,12px);padding:16px 18px;box-shadow:var(--ab-shadow,0 2px 8px #1c273107)}\n.md-page *,.md-dialog *{box-sizing:border-box}\n.md-page button,.md-dialog button{font-family:inherit;cursor:pointer}\n.md-page button:disabled{cursor:not-allowed;opacity:.5}\n.md-page :focus-visible,.md-dialog :focus-visible{outline:2px solid var(--md-blue);outline-offset:2px}\n.md-pagehead,.md-title,.md-log-head,.md-frame-note,.md-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:10px}\n.md-pagehead{margin-bottom:16px}\n.md-page .md-pagehead>.ab-section-title{position:relative;padding-left:12px;margin:0;font-size:16px;line-height:1.4;font-weight:650;color:inherit;letter-spacing:0}\n.md-page .md-pagehead>.ab-section-title:before{content:\"\";position:absolute;left:0;top:3px;bottom:3px;width:4px;border-radius:2px;background:var(--md-blue)}\n.md-page .ab-btn,.md-dialog .ab-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:5px 11px;border:1px solid var(--ab-line-2,#d8dfe5);background:#fff;color:inherit;border-radius:7px;font:inherit;font-size:13px;font-weight:500;white-space:normal}\n.md-page .ab-btn.primary,.md-dialog .ab-btn.primary,.md-page .ab-btn.is-on{background:var(--md-blue);border-color:var(--md-blue);color:#fff}\n.md-page .ab-btn:hover:not(:disabled),.md-dialog .ab-btn:hover{box-shadow:0 0 0 1px #8eb4e5}\n.md-page .md-link,.md-dialog .md-link{justify-self:start;color:var(--md-blue);border:0;background:transparent;padding:2px 0;min-height:24px;font-size:12px}\n.md-page .md-example,.md-page .md-mini{padding:2px 7px;min-height:25px;font-size:12px}\n.md-camera .md-pagehead{margin:0 0 16px}\n.md-camera-title,.md-camera-icon,.md-result-head,.md-result-action,.md-tuning-fold>summary{display:flex;align-items:center}\n.md-camera-title{gap:10px;flex-wrap:wrap}\n.md-camera-title h2{line-height:1.4;font-family:inherit;font-size:16px;font-weight:650;margin:0}\n.md-camera-icon{width:32px;height:32px;justify-content:center;border-radius:10px;background:var(--ab-foam,#eaf2fd);color:var(--md-blue)}\n.md-origin{position:relative;display:inline-flex;align-items:center;color:var(--md-muted);font-size:12px}\n.md-origin svg,.md-origin::after{position:absolute;pointer-events:none}\n.md-origin svg{inset-inline-start:8px}.md-origin::after{inset-inline-end:8px}\n.md-origin select{appearance:none;min-height:32px;line-height:20px;margin:0;padding:5px 25px 5px 29px;border:1px solid var(--md-line);border-radius:8px;background:var(--ab-card-2,#f6f8fa);color:inherit;cursor:pointer}\n@media(forced-colors:active){.md-origin select{appearance:auto;padding-inline-end:4px}.md-origin::after{display:none}}\n.md-studio{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);align-items:start;gap:clamp(14px,2vw,28px)}\n.md-subjects{border:0;padding:0;margin:0;min-width:0}.md-subjects legend{font-size:13px;font-weight:620;padding:0;margin-bottom:7px}\n.md-subjects>div{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px}\n.md-subject{--lens:#4077a2;--tint:#eaf3fb;color:#435062;background:var(--ab-card-2,#f7f8fb);padding:8px 2px;display:flex;flex-direction:column;gap:5px;align-items:center;border:0;border-radius:9px;font:inherit;font-size:12px;min-width:0}\n.md-subject>svg{color:var(--lens)}.md-subject-portrait{--lens:#7565a2;--tint:#f0eefa}.md-subject-selfie{--lens:#367493;--tint:#e9f4fa}.md-subject-object{--lens:#a06e31;--tint:#faf2e7}.md-subject-environment{--lens:#38796b;--tint:#e8f3ef}\n.md-subject:hover,.md-subject[aria-pressed=true]{background:var(--tint);color:var(--lens)}.md-subject[aria-pressed=true]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--lens) 45%,transparent);font-weight:650}\n.md-shot-result{min-width:0;display:grid;gap:9px;background:linear-gradient(115deg,#f0f6fd,#f7f9fc 75%);border-radius:12px;padding:13px 15px}\n.md-result-head{justify-content:space-between;gap:8px}.md-result-head small,.md-frame-note,.md-audience,.md-result-action small{font-size:12px;color:var(--md-muted)}\n.md-result-head h3{font-size:16px;margin:2px 0 0;line-height:1.35}.md-result-head h3:before{display:none}\n.md-audience{padding:2px 8px;color:#405e84;border-radius:20px;background:#fff}\n.md-result-action{flex-wrap:wrap;gap:8px}.md-camera .md-shoot{min-height:35px}\n.md-reason{font-size:12px;color:var(--md-muted);margin:0}\n.md-tuning-fold{border-radius:9px;background:var(--ab-card-2,#f6f8fa);margin-top:16px}.md-tuning-fold>summary{gap:8px;padding:9px 13px;color:#445c78;cursor:pointer;list-style:none}.md-tuning-fold>summary small{color:var(--md-muted);margin-left:auto;font-size:12px}\n.md-tuning-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;padding:9px 13px 15px}\n.md-samples{font-size:12px;color:#41648e}.md-samples>summary{cursor:pointer}.md-samples[open] .md-examples{margin-top:7px}\n.md-delivery{display:flex;align-items:end;flex-wrap:wrap;gap:10px}.md-delivery .md-field{min-width:100px}.md-delivery .md-check{min-height:32px}\n\n.md-logbook{border:1px solid var(--md-line);border-radius:9px;background:var(--ab-card,#fff);padding:13px;min-width:0}\n.md-title h3,.md-dialog h3{margin:0;font-size:14px;font-weight:650;color:inherit}\n.md-title>span,.md-title>small,.md-help,.md-explain p{color:var(--md-muted);font-size:12px;line-height:1.6}\n.md-help,.md-explain p{margin:0}\n.md-camera .md-sheet{min-width:0}\n.md-examples,.md-filters,.md-keytags,.md-actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px}\n\n.md-frame{background:#fff;display:grid;place-items:center;border-radius:8px;min-height:82px;overflow:hidden}.md-frame:has(>img){height:152px}.md-frame .md-image-empty{color:#65798e;gap:4px}\n.md-frame>img{display:block;width:100%;height:100%;object-fit:contain;min-height:0}\n.md-image-empty,.md-empty{display:grid;place-items:center;align-content:center;gap:7px;font-size:12px;color:var(--md-muted);text-align:center}\n.md-image-empty{width:100%;height:100%;min-width:0}\n.md-image-empty small{font-size:12px}\n.md-frame-note{margin:0;color:var(--md-muted);font-size:12px;justify-content:flex-start;flex-wrap:wrap}\n.md-frame-note span+span:before{content:\"·\";padding-right:8px}\n.md-compose{display:grid;gap:15px;align-content:start}\n.md-field{display:grid;gap:5px;color:inherit;font-size:12px;font-weight:600;min-width:0}\n.md-field input,.md-field textarea,.md-field select{font-family:inherit;font-size:13px;font-weight:400;line-height:1.5;width:100%;min-width:0;background:var(--ab-card,#fff);border:1px solid var(--ab-line-2,#d6dde4);border-radius:7px;color:inherit;padding:6px 9px}\n.md-field>textarea{resize:vertical}.md-check{display:flex;align-items:center;gap:6px;font-size:12px}\n.md-check input{accent-color:var(--md-blue)}\n.md-receipt,.md-warning{padding:8px 10px;border-radius:6px;background:#eff5fc;color:#385574}\n.md-refs b{font-size:13px;font-weight:600}\n.md-refs small{display:block;color:var(--md-muted);font-size:12px;line-height:1.5}\n.md-receipt{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px}\n.md-warning{margin:0;background:#fff5e8;color:#845014;font-size:12px}\n\n\n.md-sheet+.md-sheet{margin-top:12px}\n.md-sheet>.md-title{margin-bottom:9px}\n.md-assets{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(172px,100%),1fr));gap:7px;margin-bottom:5px}\n.md-asset{min-width:0;text-align:left;padding:5px 7px;display:grid;grid-template-columns:36px minmax(0,1fr) 12px;gap:6px;align-items:center;border:1px solid var(--md-line);border-radius:7px;color:inherit;background:#fff}\n.md-asset>img,.md-asset>.md-image-empty{width:36px;height:36px;object-fit:contain;background:#f5f6f8;border-radius:4px}\n.md-asset>.md-image-empty small{display:none}\n.md-asset small,.md-asset strong,.md-log-copy small,.md-log-copy b,.md-print-info strong,.md-print-info small{display:block}\n.md-asset small,.md-log-copy small,.md-print-info small,.md-chip{font-size:11px;color:var(--md-muted)}\n.md-asset strong,.md-print-info strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}\n.md-asset b{color:var(--md-blue)}\n.md-asset.is-picked{border-color:#85afdf;background:#f3f7fd}\n.md-editgrid,.md-info{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 10px}\n.md-refs{padding:0;margin:0;list-style:none}\n.md-refs li{display:flex;align-items:center;gap:8px;padding:4px 0}\n.md-refs li>span,.md-chip{color:#445d7a;background:#f0f4f9;font-size:11px;border-radius:4px;padding:2px 5px;white-space:nowrap}\n.md-refs li>div{flex:1;min-width:0;overflow-wrap:anywhere}\n.md-explain{margin-top:8px}.md-explain summary{cursor:pointer;font-size:12px;color:var(--md-muted)}.md-explain p{margin-top:5px}\n.md-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:10px;margin-top:12px}\n.md-print{border:1px solid var(--md-line);border-radius:8px;overflow:hidden;min-width:0;padding:0;background:#fff;text-align:left;align-self:start;color:inherit}\n.md-print-image{display:grid;place-items:center;aspect-ratio:4/3;overflow:hidden;background:var(--ab-card-2,#f4f5f7)}\n.md-print-image img{width:100%;height:100%;object-fit:contain;min-height:0}\n.md-print-info{display:grid;gap:3px;padding:7px 9px}\n.md-empty{margin-top:10px;border:1px dashed var(--md-line);border-radius:8px;min-height:95px;padding:14px}\n.md-statbar{display:flex;gap:7px;flex-wrap:wrap;margin:2px 0 12px}\n.md-stat{display:inline-flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid var(--md-line);border-radius:7px;background:#fff;color:inherit;font-size:13px}\n.md-stat small{font-size:12px}.md-stat strong{font-size:13px;font-weight:650}.md-stat.is-on{border-color:#9bbde6;background:#eef4fc}\n.md-log-head h2{font-weight:650;font-size:14px;margin:0}\n.md-log-head>div{display:flex;gap:7px}.md-log-head select{min-width:84px}\n.md-day{font-size:12px;margin:12px 0 0;color:var(--md-muted)}\n.md-log{width:100%;display:grid;grid-template-columns:40px 6px 34px minmax(0,1fr) auto 8px;align-items:center;min-width:0;gap:8px;border:0;border-bottom:1px solid var(--md-line);background:transparent;color:inherit;text-align:left;padding:8px 1px}\n.md-log:hover{background:#f6f8fa}.md-log time,.md-badge{font-size:11px}\n.md-log-thumb{width:34px;height:32px;display:grid;place-items:center;color:#66778a;background:#f3f5f7;border-radius:4px;overflow:hidden}\n.md-log-thumb img{width:100%;height:100%;object-fit:contain}.md-log-thumb .md-image-empty small{display:none}\n.md-log-copy b{font-size:13px;font-weight:600;overflow-wrap:anywhere}\n.md-dot{height:6px;width:6px;display:block;border-radius:50%;background:#438375}.md-dot.wait{background:#ae7a35}.md-dot.fail{background:#b95f5f}.md-dot.quiet{background:#8494a2}\n.md-badge{padding:2px 6px;border-radius:5px;background:#eff5f4;color:#38695f}.md-badge.wait{background:#fcf4e6;color:#886228}.md-badge.fail{background:#fcf0f0;color:#924b50}\n.md-dialog{padding:0;border:1px solid var(--md-line);border-radius:12px;max-width:calc(100% - 24px);width:590px;max-height:90vh;box-shadow:0 12px 40px #1b2e4533;background:white}.md-dialog::backdrop{background:#18263870}\n.md-dialog-head{position:sticky;top:0;background:#fff;padding:12px 15px;border-bottom:1px solid var(--md-line);z-index:2}.md-dialog-head h2{margin:0;font-size:16px;overflow-wrap:anywhere}\n.md-shot-image{background:#f4f5f7;display:grid;place-items:center;height:190px}.md-shot-image img{height:100%;width:100%;object-fit:contain;min-height:0}\n.md-shot-meta,.md-record-detail{padding:13px 15px}.md-info{margin:0 0 14px}.md-info dt{font-size:11px;color:var(--md-muted)}.md-info dd{font-size:13px;margin:0;overflow-wrap:anywhere}\n.md-shot-meta .md-field{margin-bottom:9px}.md-record-detail h3{margin:12px 0 4px}.md-record-detail p{margin:0;font-size:13px;line-height:1.6}\n.md-record-detail .md-info{margin:12px 0}.md-record-result{display:flex;align-items:center;gap:8px;margin-top:10px}.md-record-result>img{max-width:58px;height:48px;object-fit:contain}.md-record-result>.md-image-empty{width:48px}.md-record-result>.md-image-empty small{display:none}\n@media(max-width:720px){.md-studio,.md-tuning-grid{grid-template-columns:1fr;gap:16px}.md-gallery{grid-template-columns:repeat(3,minmax(0,1fr))}.md-page{padding:12px}.md-frame:has(>img){height:125px}}\n@media(max-width:480px){.md-gallery{grid-template-columns:repeat(2,minmax(0,1fr))}.md-page{padding:10px}.md-logbook{padding:10px}.md-shot-result{padding:11px}.md-camera-title{gap:6px}.md-camera-icon{width:26px;height:26px}.md-log{grid-template-columns:34px 26px minmax(0,1fr) auto;gap:5px}.md-log>i,.md-log>span:last-child{display:none}.md-log-thumb{width:26px;height:26px}.md-log-head{align-items:start;flex-direction:column}.md-statbar{gap:4px}.md-stat{padding:4px 6px}}\n\n.md-collection-title{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:650}\n.md-collection-icon{display:grid;place-items:center;width:33px;height:33px;border-radius:10px;color:#74529a;background:#f1ebf9}\n[data-page=records] .md-collection-icon{color:#2d7874;background:#e6f4f1}\n[data-page=records] .md-logbook{padding:12px 0 0;border:0}\n[data-page=records] .md-log{border:0;border-radius:6px;padding-block:9px}\n[data-page=records] .md-log-head{margin-bottom:10px}\n[data-page=records] .md-stat{border:0;padding:7px 12px;border-radius:7px;background:#f0f3f8}\n[data-page=records] .md-stat.good{background:#edf6f1;color:#2c7155}\n[data-page=records] .md-stat.wait{background:#fbf4e6;color:#8b611f}\n[data-page=records] .md-stat.fail{background:#fbefee;color:#964d47}\n[data-page=records] .md-stat.is-on{box-shadow:inset 0 0 0 1px #87acd5}\n[data-page=album] .md-gallery{gap:14px}\n[data-page=album] .md-print{border-color:transparent;background:#f7f8fb;border-radius:10px}\n[data-page=album] .md-print:hover{background:#eef2f7}\n.md-inbox-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 20px;margin:16px 0}\n.md-inbox-fields input,.md-inbox-fields select{box-sizing:border-box;width:100%;min-width:0;min-height:36px;padding:6px 9px;color:inherit;background:var(--ab-surface,#fff);border:1px solid var(--md-line);border-radius:7px;font:inherit}\n.md-inbox-empty{margin-top:20px}.md-inbox-empty h3{font-size:14px;margin:0}\n@media(max-width:580px){.md-inbox-fields{grid-template-columns:1fr}}\n\n.md-word-picker{margin-top:16px;padding:14px 0;color:var(--md-ink)}\n.md-word-picker>.md-title{margin-bottom:10px;flex-wrap:wrap}\n.md-word-picker small{color:var(--md-muted)}\n.md-word-picker fieldset{min-width:0;margin:0 0 9px;padding:0;border:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(90px,146px);gap:6px 12px;align-items:start}\n.md-word-picker legend{font-size:12px;font-weight:600;margin-bottom:4px}\n.md-words{display:flex;gap:4px;flex-wrap:wrap}\n.md-word-picker input,.md-album-search input{min-width:0;width:100%;padding:5px 8px;border:1px solid var(--md-line,#dce4ee);border-radius:7px;font:inherit;background:#fff;color:inherit}\n.md-album-search{max-width:420px;margin:8px 0}\n.md-shot-result .md-frame{height:155px;min-height:0;width:auto;max-width:100%;justify-self:center}\n.md-shot-result .md-frame:has(>img){height:155px}\n@media(max-width:540px){.md-word-picker fieldset{grid-template-columns:minmax(0,1fr)}.md-word-picker fieldset input{max-width:15em}.md-shot-meta .md-editgrid{grid-template-columns:minmax(0,1fr)}}\n\n:scope .md-page .cp-log-tools{margin-top:14px}\n:scope .cp-note-tools{margin-bottom:12px}\n:scope .cp-note-main{display:flex;align-items:center;gap:7px;margin-bottom:12px;font-size:13px}\n:scope .cp-note-main input{width:auto;min-height:0;margin:0}\n:scope .md-shot-meta .md-field input:not([type=checkbox]),:scope .md-shot-meta .md-field textarea{width:100%;min-width:0}\n:scope .cp-inbox-file{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0}\n:scope .cp-inbox-file div{min-width:0;overflow-wrap:anywhere}\n:scope .cp-inbox-file small{display:block;color:var(--md-muted)}\n:scope .cp-inbox-file a{flex:none}\n:scope .md-dialog{scrollbar-width:thin}\n\n.rs-page .page-head{display:flex;align-items:center;justify-content:space-between;gap:8px}\n.rs-page .cp-inline-upload{display:inline-flex;align-items:center;position:relative}\n.cp-inline-upload input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}\n.cp-inline-upload:focus-within{outline:2px solid var(--rs-blue);outline-offset:2px}\n.rs-board .cp-board-view{padding:0;border:0;background:transparent;width:100%;height:100%;min-height:0}\n\n}"
// End reviewed workbench assets
const RelationshipPanel=createRelationshipPanel((path,body)=>call('/relation'+path,body))
return function Panel({toast,reload}) {
  const [moduleSettings,setModuleSettings]=useState(false)
  const [data,D]=useState(null),[tab,T]=useState('life'),[cfg,C]=useState({}),[busy,B]=useState(false),[message,M]=useState(''),[error,E]=useState(false)
  const [roles,R]=useState({}),[persona,P]=useState(''),[deleteAssets,DA]=useState([]),[deletePhotos,DP]=useState([]),[edits,ED]=useState({}),[editor,EE]=useState(''),[dirty,DI]=useState(false)
  const [request,Q]=useState(''),[wear,W]=useState(''),[shotStyle,setShotStyle]=useState('auto'),[shape,SH]=useState('portrait'),[reference,REF]=useState(''),[previewJob,PJ]=useState(''),[previewId,PI]=useState(''),[viewer,V]=useState(''),[zoom,Z]=useState(false)
  const [annotationCheckError,setAnnotationCheckError]=useState('')
  const [identityImport,setIdentityImport]=useState(null),[framing,setFraming]=useState('portrait'),[keywords,setKeywords]=useState({})
  const [dismissedConversion,setDismissedConversion]=useState(''),[stateUnavailable,setStateUnavailable]=useState(false)
  const [materialEditing,setMaterialEditing]=useState(false),[materialSearch,setMaterialSearch]=useState(''),[materialExtras,setMaterialExtras]=useState(false)
  const [materialKind,setMaterialKind]=useState('identity'),[materialIndex,setMaterialIndex]=useState(0),[selectedMaterials,setSelectedMaterials]=useState([])
  useEffect(()=>{setSelectedMaterials([])},[data?.activeProfileId])
  useEffect(()=>{setMaterialIndex(0)},[persona,materialKind])
  const conversionJob=data?.jobs?.find(j=>j.stage==='studio-draft'&&j.personaId===persona&&
    (j.id===identityImport?.waitingFor || identityImport?.missingReceipt&&j.requestId===identityImport.requestId))
  useEffect(()=>{
    if(!conversionJob)return
    const job=conversionJob
    if(identityImport?.missingReceipt){
      setIdentityImport(item=>item?.missingReceipt&&item.requestId===job.requestId?{...item,waitingFor:job.id,missingReceipt:false,conversionError:''}:item)
      return
    }
    if(!['generated','unknown','failed'].includes(job.status))return
    if(job.status==='generated'&&!job.reviewNotice&&!dirty){
      revision.current=data.revision
      settingsBaseline.current=data.settings
      C(data.settings)
    }
    setIdentityImport(item=>{
      if(item?.waitingFor!==job.id)return item
      if(job.reviewNotice)return {...item,waitingFor:'',conversionError:job.reviewNotice}
      if(job.status!=='generated')return {...item,waitingFor:'',conversionError:job.error||(job.status==='unknown'?'生图结果待核对。请查看记录，避免重复生成。':'转换未完成。')}
      return {...item,waitingFor:'',conversionError:'',boardId:job.boardId,draftId:job.id,metadata:{...job.metadata,...item.overrides},requestId:crypto.randomUUID()}
    })
  },[conversionJob?.id,conversionJob?.status,identityImport?.missingReceipt,identityImport?.waitingFor])
  const [albumPage,AP]=useState(1),[albumSize,AS]=useState(12),[jobsPage,JP]=useState(1),[jobsSize,JS]=useState(10)
  const [lifeViews,LV]=useState({}),[lifeDrafts,LD]=useState({}),[lifeLoading,LL]=useState(false),[lifeError,LE]=useState('')
  const [inner,I]=useState(null),[innerEditor,IE]=useState(null),[activityTitle,AT]=useState(''),[activityEdit,AE]=useState(null),[adapter,AD]=useState(false)
  const [lifeDayKind,setLifeDay]=useState('regular'),[lifeStory,setLifeStory]=useState(0)
  const [lifeForecast,setLifeForecast]=useState(null),[lifeDetail,setLifeDetail]=useState(''),[lifePlace,setLifePlace]=useState('')
  useEffect(()=>{setLifeForecast(null);setLifeDetail('');setLifePlace('');setSceneDraft(null)},[persona])
  const [lifeEditor,LEdit]=useState(''),[presetSelection,PS]=useState({}),[replacePreset,RP]=useState(false),[pendingPreset,PP]=useState(null),[undoPreset,UP]=useState(null)
  const [scheduleOnly,SO]=useState(false),[upgradeGroups,setUpgradeGroups]=useState([])
  const [readKind,RK]=useState('all'),[readDate,RD]=useState(''),[entryId,EI]=useState(''),[readPage,RPg]=useState(1)
  const [sceneDraft,setSceneDraft]=useState(null)
  const [cameraOrigin,setCameraOrigin]=useState('panel'),[sceneMode,setSceneMode]=useState('current'),[recordKind,setRecordKind]=useState(''),[albumKind,setAlbumKind]=useState(''),[albumSearch,setAlbumSearch]=useState('')
  const [cameraPlace,setCameraPlace]=useState(''),[textMaterials,setTextMaterials]=useState([])
  const cameraSeed=useRef(null),[cameraLink,setCameraLink]=useState(null)
  useEffect(()=>{setCameraPlace('');setTextMaterials([])},[data?.activeProfileId])
  useEffect(()=>{
    if(tab!=='photo'||!data?.activeProfileId||cameraSeed.current===data.activeProfileId)return
    const state=data.life?.state,who=data.personas.find(p=>p.id===data.personaId)?.name
    if(!state||!who)return
    const initial=[who,state.location?'在'+state.location:'',state.activity?'正在'+state.activity:''].filter(Boolean).join('，')+'。'
    const changedCharacter=cameraSeed.current!==null&&cameraSeed.current!==data.activeProfileId
    Q(previous=>changedCharacter?initial:previous||initial)
    cameraSeed.current=data.activeProfileId
  },[tab,data?.activeProfileId,data?.life?.state?.activity])
  useEffect(()=>{PJ('');PI('')},[framing,shape,request,wear,selectedMaterials,reference,shotStyle,sceneMode,cameraPlace,keywords,textMaterials,cameraOrigin,data?.activeProfileId])
  const [inboxView,showInbox]=useState(false),[inbox,setInbox]=useState(null),[inboxError,setInboxError]=useState('')
  const [jobFilter,setJobFilter]=useState(''),[openJob,setOpenJob]=useState(''),[albumFeedback,setAlbumFeedback]=useState('')
  const albumUpload=useRef(null)
  useEffect(()=>{setOpenJob('');setAlbumFeedback('');setAlbumSearch('');setAlbumKind('');setJobFilter('');setRecordKind('')},[persona])
  async function refreshInbox(){
    const r=await call('/inbox')
    if(!r?.ok)throw Error(r?.message||'收件箱读取失败')
    if(alive.current){setInbox(r);setInboxError('')}
  }
  useEffect(()=>{
    if(tab==='jobs'&&inboxView)refreshInbox().catch(e=>setInboxError(e.message))
  },[tab,inboxView])
  const relationshipEditor=useRef(null)
  const [relationPending,setRelationPending]=useState(false),[seenRelation,showRelation]=useState(false),[relationSummary,setRelationSummary]=useState(null)
  useEffect(()=>{
    if(tab!=='life'||!persona)return
    let current=true
    const update=()=>call('/relation/state?persona='+encodeURIComponent(persona)).then(r=>{
      if(current)setRelationSummary(r.ok&&r.viewingPersona===persona?r:null)
    }).catch(()=>{if(current)setRelationSummary(null)})
    update();const interval=setInterval(update,30000)
    return ()=>{current=false;clearInterval(interval)}
  },[tab,persona])
  useEffect(()=>{
    if(!dirty&&!relationPending)return
    const protect=e=>{e.preventDefault();e.returnValue=true}
    window.addEventListener('beforeunload',protect)
    return ()=>window.removeEventListener('beforeunload',protect)
  },[dirty,relationPending])
  function selectPersona(id){
    if(identityImport){notify('请先将转换稿入库或清空草稿。',true);return}
    setMaterialEditing(false);setMaterialSearch('')
    if(dirty||relationPending||relationshipEditor.current?.busy){notify('请先保存当前人格的修改。',true);return}
    if(tab!=='romance')showRelation(false)
    setIdentityImport(null);setRelationSummary(null);IE(null);EE('');V('');PJ('');PI('');REF('');setSelectedMaterials([]);setMaterialIndex(0)
    P(id)
  }
  const scope=useRef('');scope.current=tab==='photo'?'':persona
  const firstSetup=useRef(new Set())
  const revision=useRef(''),loading=useRef(false),alive=useRef(true)
  const settingsBaseline=useRef(null)
  const draftOpen=useRef(false)
  draftOpen.current=Boolean(dirty||busy||relationPending||identityImport||editor||lifeEditor||pendingPreset||innerEditor||activityEdit||activityTitle||Object.keys(roles).length||Object.keys(lifeDrafts).length)
  const notify=(text,failed=false)=>{M(text);E(failed)}
  async function load(reset=false) {
    const id=scope.current,atRevision=revision.current
    const r=await call('/state'+(id?'?persona='+encodeURIComponent(id):''));if(!r.ok)throw new Error(r.message||'加载失败')
    if(!alive.current||id!==scope.current)return
    if(!reset&&atRevision!==revision.current)return
    setStateUnavailable(false);D(r)
    if(reset){revision.current=r.revision;settingsBaseline.current=r.settings}
    else if(!draftOpen.current&&!relationshipEditor.current?.editing&&revision.current!==r.revision){
      revision.current=r.revision;settingsBaseline.current=r.settings;C(r.settings)
    }
    if(reset){C(r.settings);R({});LD({});DA([]);DP([]);ED({});EE('');PP(null);UP(null);DI(false);P(p=>r.personas.some(x=>x.id===p)?p:r.personaId||r.personas[0]?.id||'')}
    return r
  }
  useEffect(()=>{alive.current=true;load(true).catch(e=>notify(e.message,true));const timer=setInterval(()=>{if(loading.current)return;loading.current=true;load().catch(()=>{if(alive.current)setStateUnavailable(true)}).finally(()=>{loading.current=false})},2500);return()=>{alive.current=false;clearInterval(timer)}},[])
  useEffect(()=>{if(!viewer)return;const key=e=>{if(e.key==='Escape')V('')};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)},[viewer])
  useEffect(()=>{setIdentityImport(null);setUpgradeGroups([]);setSelectedMaterials([]);setMaterialIndex(0);LEdit('');PS({});RP(false);PP(null);UP(null);AT('');AE(null);RK('all');RD('');EI('')},[persona])
  useEffect(()=>{RPg(1)},[persona,readKind,readDate])
  useEffect(()=>{
    if(tab!=='life'||!persona)return
    let current=true;LL(true);LE('')
    call('/life-persona',{personaId:persona}).then(r=>{if(!current)return;if(!r.ok)throw new Error(r.message||'生活配置读取失败');LV(all=>({...all,[persona]:r.life}));if(tab==='life'&&r.life.available&&!r.life.revision&&!firstSetup.current.has(persona)){firstSetup.current.add(persona);LEdit('preset')}})
      .catch(e=>{if(current)LE(e.message)}).finally(()=>{if(current)LL(false)})
    return()=>{current=false}
  },[tab,persona,data?.revision,data?.life?.card?.revision])
  useEffect(()=>{
    if(tab!=='life'||!persona)return
    let current=true,pending=false;I(null);IE(null)
    const update=async()=>{if(pending)return;pending=true;try{const r=await call('/life-records',{personaId:persona});if(current&&r.ok){I(r.inner);AD(r.requestAdapter)}}catch{}finally{pending=false}}
    update();const timer=setInterval(update,3000);return()=>{current=false;clearInterval(timer)}
  },[tab,persona])
  useEffect(()=>{if(persona)load().catch(e=>notify(e.message,true))},[persona,tab==='photo'])
  const albumPersona=data?.viewingPersonaId??data?.personaId,albumProfile=data?.viewingProfileId??data?.activeProfileId
  useEffect(()=>{
    if(!cameraLink||cameraLink.persona!==persona||albumPersona!==persona||tab!==cameraLink.tab)return
    if(cameraLink.tab==='gallery'){
      const p=data.photos.find(p=>p.id===cameraLink.id)
      if(p)editPhoto(p)
    }else setOpenJob(cameraLink.id)
    setCameraLink(null)
  },[cameraLink,persona,albumPersona,tab])
  useEffect(()=>{AP(1);JP(1)},[albumPersona,albumProfile])
  useEffect(() => {
    if(tab!=='gallery'||!albumProfile||albumPersona!==persona)return
    let current = true
    setAnnotationCheckError('')
    call('/check-annotations', { personaId: albumPersona, profileId: albumProfile })
      .then(result => {
        if (!current) return
        if (!result.ok) throw new Error('检查注释未完成')
        if (result.restored || result.queued) return load()
      })
      .catch(() => { if (current) setAnnotationCheckError('检查注释未完成，请重新打开相册。') })
    return () => { current = false }
  }, [tab,persona,albumPersona,albumProfile])
  async function run(fn){if(busy)return;B(true);try{const r=await fn();if(r?.ok===false)throw new Error(r.message||'操作未完成');if(r?.message)notify(r.message);return r}catch(e){notify(e.message,true);return null}finally{B(false)}}
  const btn=(text,fn,disabled=false,primary=false)=>h('button',{type:'button',className:'ab-btn'+(primary?' primary':''),disabled:busy||disabled,onClick:()=>run(fn)},text)
  const pager=(list,size,setSize,setPage,sizes,label)=>list.total?h('nav',{className:'cp-row cp-pager','aria-label':label},
    h('label',null,'每页',h('select',{className:'ab-input',value:size,onChange:e=>{setSize(Number(e.target.value));setPage(1)}},...sizes.map(n=>h('option',{key:n,value:n},n)))),
    hint('共 '+list.total+' 项 · '+list.page+' / '+list.pages),
    btn('上一页',()=>setPage(list.page-1),list.page<=1),btn('下一页',()=>setPage(list.page+1),list.page>=list.pages)):null
  const tabButton=(key,label)=>h('button',{type:'button',key,className:'ab-btn'+(tab===key?' primary':''),'aria-pressed':tab===key,onClick:()=>{if(key==='romance')showRelation(true);T(key);if(key==='life')LEdit('')}},label)
  const tabs=()=>h('div',{className:'cp-tabs'},h('nav',{className:'cp-navigation','aria-label':'模块分项'},
    ...[['life','生活'],['setup','设定'],['romance','恋爱'],['photo','拍照'],['gallery','相册'],['jobs','记录']].map(([key,label])=>tabButton(key,label))),
    h('div',{className:'cp-nav-end'},
      btn('编辑原卡',openPersonaCard,!persona),
      h('select',{className:'ab-input cp-persona-select',value:persona,disabled:busy||!data.personas.length,onChange:e=>selectPersona(e.target.value),'aria-label':'选择人格卡',title:'选择要编辑的人格卡'},
        ...data.personas.map(p=>h('option',{key:p.id,value:p.id},p.name)))))
  const update=(key,value)=>{C(c=>({...c,[key]:value}));DI(true)}
  function changeLife(patch){
    const v=lifeViews[persona];if(!v?.available||lifeLoading)return
    LD(all=>({...all,[persona]:{...(all[persona]||{personaId:persona,revision:v.revision,cardRevision:v.card.revision}),config:{...(all[persona]?.config||v.config),...patch}}}))
    PP(null);UP(null);DI(true)
  }
  async function previewPreset(selection=presetSelection,replace=replacePreset){
    const draft=lifeDrafts[persona]
    const r=await call('/life-preset',{personaId:persona,cardRevision:draft?.cardRevision??lifeView.card.revision,revision:draft?.revision??lifeView.revision,config:lifeCfg,selection,replace,scheduleOnly,upgradeGroups})
    if(r.ok)PP({...r.preview,selection,base:lifeCfg,persona})
    return r
  }
  function applyPreset(){
    if(!pendingPreset||pendingPreset.persona!==persona||pendingPreset.base!==lifeCfg)throw Error('草稿已变化，请重新预览')
    const before=lifeDrafts[persona]||null
    changeLife(pendingPreset.config);UP({persona,before})
    notify('已套用到当前人格的草稿，可继续调整后保存。')
  }
  function undoAppliedPreset(){
    if(!undoPreset||undoPreset.persona!==persona)return
    LD(all=>{const next={...all};if(undoPreset.before)next[persona]=undoPreset.before;else delete next[persona];return next})
    if(!undoPreset.before&&Object.keys(lifeDrafts).length===1&&!Object.keys(roles).length&&!deleteAssets.length&&!deletePhotos.length&&!Object.values(edits).some(e=>e.touched)&&JSON.stringify(cfg)===JSON.stringify(data.settings))DI(false)
    UP(null);notify('已撤销这次套用。')
  }
  async function lifeAction(payload){
    if(!lifeViews[persona]?.card||!inner)throw Error('请先读取此人格的生活资料')
    const r=await call('/life-action',{personaId:persona,cardRevision:lifeViews[persona].card.revision,revision:inner.revision,...payload});if(r.ok){I(r.inner);IE(null);AT('');await load()}return r
  }
  async function reflect(kind){if(dirty)throw Error('请先保存设置');const r=await call('/life-reflect',{personaId:persona,kind});if(r.ok){const next=await call('/life-records',{personaId:persona});if(next.ok)I(next.inner)}return r}
  function roleFor(id){
    if(roles[id])return roles[id]
    const bound=data.personaBindings[id],fallback=id===data.personaId&&!Object.values(data.personaBindings).includes(data.manualProfileId)?data.manualProfileId:''
    const profile=data.profiles.find(p=>p.id===(bound||fallback)),version=data.versions.find(v=>v.id===profile?.versionId)
    const wardrobe=(data.managedOutfits||[]).filter(o=>o.profileId===profile?.id)
    const chosen=wardrobe.findIndex(o=>o.id===profile?.defaultOutfit)
    return {outfitOccasions:profile?.outfitOccasions||{},materials:(data.managedMaterials||[]).filter(m=>m.profileId===profile?.id),defaultOutfit:chosen>=0?String(chosen):profile?.defaultOutfit==='original'?'original':'auto',personaId:id,profileId:profile?.id||'',mainId:version?.references[0]||'',extraId:version?.references[1]||'',extra2Id:version?.references[2]||'',bodyMeasurements:version?.bodyMeasurements||{},notes:version?.notes||'',fixedFeatures:version?.fixedFeatures||'',variableAppearance:version?.variableAppearance||'',referenceNotes:Object.fromEntries((version?.references||[]).map(id=>[id,data.assets.find(a=>a.id===id)?.note||''])),outfits:(data.managedOutfits||data.outfits).filter(o=>o.profileId===profile?.id).map(o=>({...o}))}
  }
  function changeRole(patch){const r=roleFor(persona);R(all=>({...all,[persona]:{...r,...patch}}));DI(true)}
  function removeRef(slot){const id=role[slot];if(id)DA(a=>[...new Set([...a,id])]);changeRole({[slot]:''});notify('图片已标记删除，点击顶部“保存设置”后删除文件及其历史引用。')}
  async function readFile(file){if(!file||file.size>8*1024*1024)throw new Error('请选择不超过 8MB 的图片');return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取图片失败'));reader.readAsDataURL(file)})}
  const upload=(label,fn)=>h('label',{className:'cp-upload'+(busy?' busy':'')},label,h('input',{type:'file',accept:'image/png,image/jpeg,image/webp',disabled:busy,onChange:e=>{const file=e.target.files[0];e.target.value='';if(file)run(()=>fn(file))}}))
  const image=(id,label,extra='')=>h('button',{type:'button',className:'cp-image '+extra,disabled:!id,onClick:()=>{V(id);Z(false)},'aria-label':label+'，点击查看大图'},id?h('img',{src:src(id),alt:label}):h('span',{className:'cp-placeholder'},'上传图片 · PNG / JPG / WebP · ≤8MB'))
  async function save(){
    const rel=relationshipEditor.current
    if(rel?.busy||rel?.needsSave&&!rel.validate())return {ok:false,message:'请核对恋爱设置后再保存。'}
    if(dirty){const r=await call('/save-all',{personaId:persona,revision:revision.current,settings:cfg,roles:Object.values(roles),lifeDrafts:Object.values(lifeDrafts),photoEdits:Object.values(edits).filter(e=>e.touched),deleteAssetIds:deleteAssets,deletePhotoIds:deletePhotos});if(!r.ok)return r;await load(true)}
    if(rel?.needsSave&&!await rel.commit())return {ok:false,message:'恋爱设置仍待保存，请查看恋爱编辑区的提示。'}
    await reload?.();return {ok:true,message:'设置已保存。'}
  }
  async function selectSources(files,targetId=''){
    if(identityImport?.waitingFor)return
    const max=materialKind==='identity'?1:4
    if(!files.length||files.length>max)throw Error('请选择 1'+(max>1?' 至 '+max:'')+' 张参考图。')
    const images=[]
    for(const f of files){
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(f.type))throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片。')
      images.push({name:f.name,base64:await readFile(f),mime:f.type})
    }
    setIdentityImport({kind:materialKind,targetId,images,instructions:'',requestId:crypto.randomUUID(),keepOriginal:true,useBoard:true,coverChoice:'board',asMain:materialKind==='identity',metadata:{}})
  }
  function uploadSources(text,targetId=''){
    return h('label',{className:'rs-link cp-inline-upload',onDragOver:e=>e.preventDefault(),onDrop:e=>{e.preventDefault();if(!busy&&!identityImport?.waitingFor)run(()=>selectSources(Array.from(e.dataTransfer.files),targetId))}},
      text,h('input',{type:'file',accept:'image/png,image/jpeg,image/webp,image/gif',multiple:materialKind!=='identity',disabled:busy||!!identityImport?.waitingFor,onChange:e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)run(()=>selectSources(files,targetId))}}))
  }
  async function convertSources(){
    if(dirty)throw Error('请先保存当前修改，再生成设定图。')
    const item=identityImport
    if(item.waitingFor||item.submitting)return
    setIdentityImport({...item,submitting:true,missingReceipt:false,conversionError:''})
    try{
      const r=await call('/material-draft',{background:true,personaId:persona,revision:revision.current,kind:item.kind,images:item.images.map(({name,base64})=>({name,base64})),instructions:item.instructions,requestId:item.requestId})
      if(!r.ok)throw Error(r.message||'无法提交设定图转换。')
      if(r.boardId){
        revision.current=r.revision||revision.current
        setIdentityImport({...item,submitting:false,conversionError:'',boardId:r.boardId,draftId:r.draftId,metadata:{...r.metadata,...item.overrides},requestId:crypto.randomUUID()})
      }else{
        setIdentityImport({...item,submitting:false,conversionError:'',waitingFor:r.draftId})
      }
      await load()
      return r
    }catch(e){
      setIdentityImport(current=>current?.submitting?{...current,submitting:false,missingReceipt:true,conversionError:e.message}:current)
      throw e
    }
  }
  async function adoptSources(){
    const item=identityImport
    if(dirty)throw Error('请先保存当前修改，再将转换稿加入素材库。')
    const r=await call('/material-adopt',{revision:revision.current,personaId:persona,draftId:item.draftId,kind:item.kind,targetId:item.targetId||undefined,asMain:item.asMain,metadata:item.metadata,keepOriginal:item.keepOriginal,useBoard:item.useBoard,coverChoice:item.coverChoice,images:item.keepOriginal||!item.useBoard?item.images.map(({name,base64})=>({name,base64})):[]})
    if(r.ok){
      setIdentityImport(null)
      const next=await load(true)
      const list=(item.kind==='outfit'?next?.managedOutfits:next?.managedMaterials)?.filter(m=>m.profileId===(next.viewingProfileId||next.personaBindings[persona]||role.profileId)&&(item.kind==='outfit'||m.kind===item.kind))
      setMaterialIndex(Math.max(0,list?.findIndex(m=>m.id===r.materialId)??0))
      notify('设定图与审阅后的识别结果已入库。')
    }
    return r
  }
  const materialTypes={
    identity:{label:'人设图',icon:'user',sheet:'人物三视图',views:'正面 · 侧面（面朝右） · 背面',hint:'全身等高，头顶与脚底对齐。保持原画风，以中性站姿和表情呈现。'},
    outfit:{label:'衣柜',icon:'wardrobe',sheet:'服装三视图',views:'正面 · 侧面 · 背面',hint:'浅灰色无五官人台展示整套服装，保留面料、鞋袜与配饰。'},
    scene:{label:'场景图',icon:'image',sheet:'空间设定图',views:'主视角 · 反向视角 · 俯视布局',hint:'上方放全景，下方左侧放反向视角、右侧放俯视布局。保持门窗、家具的位置一致。'},
    object:{label:'道具',icon:'coffee',sheet:'道具三视图',views:'正面 · 侧面 · 背面 · 45° 斜侧',hint:'单独展示物件，去除手和原背景。四个角度比例一致，底部对齐。'}
  }
  function studioField(label,control,wide=false){
    return h('label',{className:'rs-field'+(wide?' rs-full':'')},h('span',{className:'rs-field-label'},label),control)
  }
  function studioFields(meta,patch){
    return h('div',{className:'rs-fields'},
      studioField('素材名称',input(meta.name||'',v=>patch({name:v}))),
      studioField('别名',input(meta.aliases||'',v=>patch({aliases:v}))),
      studioField('关键词标签',input(meta.tags||'',v=>patch({tags:v})),materialKind!=='identity'),
      materialKind==='identity'?studioField('神态特点（选填）',input(meta.expression||'',v=>patch({expression:v}))):null,
      studioField(materialKind==='identity'?'稳定外观':'外观描述',area(meta.description||'',v=>patch({description:v})),true))
  }
  function studioButton(label,fn,cls='btn',disabled=false,props={}){
    return h('button',{type:'button',className:cls,disabled:busy||disabled,onClick:()=>run(fn),...props},label)
  }
  function materialStudio(list){
    const t=materialTypes[materialKind], item=identityImport?.kind===materialKind?identityImport:null
    const latest=data.jobs.find(j=>j.stage==='studio-draft'&&j.personaId===persona&&j.kind===materialKind)
    const prior=!item&&latest&&!latest.materialId&&latest.id!==dismissedConversion?latest:null
    const job=conversionJob||prior
    const active=!!item?.submitting||!!item?.waitingFor||['planning','generating'].includes(prior?.status)
    const progress=stateUnavailable?'正在重新连接任务记录':item?.submitting?'正在提交参考图':job?.status==='generating'?'正在生成'+t.sheet:job?.status==='planning'?'正在识别参考图':'等待任务状态'
    const boardId=item?.boardId||(prior?.status==='generated'&&prior.boardId)
    const issue=item?.conversionError||(['failed','unknown'].includes(prior?.status)&&(prior.error||'上次任务未确认完成，请查看记录。'))
    const step=job?.status==='generating'?'第 2 步，共 2 步':job?.status==='planning'?'第 1 步，共 2 步':''
    const plan=studioPromptPlan(materialKind,item?.metadata?.description||'',item?.instructions||'',item?.images?.length||0)
    const update=patch=>setIdentityImport({...item,...patch})
    const choose=(label,value,fn,options)=>studioField(label,select(value,fn,options))
    const saveOptions=item?.keepOriginal?[['board','转换图'],['source','原图']]:[['board','转换图']]
    const stored=list.find(m=>m.referenceId)
    async function reuseSource(){
      const response=await fetch(src(stored.referenceId))
      if(!response.ok)throw Error('原图暂时无法读取。')
      const blob=await response.blob()
      return selectSources([new File([blob],stored.name,{type:blob.type})],stored.id)
    }
    const generateLabel={identity:'人物三视图',outfit:'服饰三视图',scene:'场景设定图',object:'道具三视图'}[materialKind]
    const newFile=files=>selectSources(Array.from(files),item?.targetId||'')
    return h('section',{className:'rs-studio'},h('header',{className:'rs-studio-head'},h('h2',null,t.sheet),h('small',null,(materialKind==='scene'?'4:3':'16:9')+' · 单张设定板')),
      h('div',{className:'rs-workbench'},h('fieldset',{className:'rs-intake',disabled:active,style:{border:0,padding:0,margin:0,minWidth:0}},
        h('div',{className:'rs-sheet-label'},h('strong',null,'参考原图')),
        h('div',{className:'rs-seeds'},...(item?.images||[]).map((v,i)=>h('figure',{key:i},h('img',{src:'data:'+v.mime+';base64,'+v.base64,alt:v.name}),h('figcaption',null,h('span',{title:v.name},v.name),studioButton('移除',()=>{const images=item.images.filter((_,j)=>i!==j);if(!images.length)setIdentityImport(null);else update({images,boardId:'',draftId:'',metadata:{},requestId:crypto.randomUUID()})},'rs-link'))))),
        h('label',{className:'rs-drop',onDragOver:e=>e.preventDefault(),onDrop:e=>{e.preventDefault();if(!busy&&!active&&e.dataTransfer.files.length)run(()=>newFile(e.dataTransfer.files))}},reviewIcon('image',22),h('b',null,item?'更换参考图':'选择或拖入参考图'),h('small',null,(materialKind==='identity'?'1 张':'1–4 张')+' · JPG / PNG / WebP / GIF · 每张最多 8 MB'),h('input',{type:'file',multiple:materialKind!=='identity',accept:'image/jpeg,image/png,image/webp,image/gif','aria-label':'上传'+t.label+'参考图',disabled:busy,onChange:e=>{const files=Array.from(e.target.files);e.target.value='';if(files.length)run(()=>newFile(files))}})),
        item?h('div',{className:'rs-tools'},studioButton('清空草稿',()=>{setDismissedConversion(latest?.id);setIdentityImport(null)},'rs-link'),!item.draftId?studioButton(active?'转换中…':'识别并生成'+generateLabel,convertSources,'btn primary',active):null):h('div',{className:'rs-tools'},stored?studioButton('载入已存原图',reuseSource,'rs-link'):null),
        item&&!item.draftId?studioField('补充制图要求（选填）',input(item.instructions,v=>update({instructions:v,requestId:crypto.randomUUID()}))):null),
        h('div',{className:'rs-sheet'},h('div',{className:'rs-sheet-label'},h('strong',null,'设定板预览'),h('span',null,active?'运行中':issue?'待处理':boardId?'转换稿':'待生成')),
          h('figure',{className:'rs-board','data-sheet-state':active?'running':issue?'error':boardId?'ready':'pending','aria-label':'单张'+t.sheet},
            active?h('div',{className:'rs-board-empty',role:'status'},h('progress',{'aria-label':progress}),h('b',null,progress),h('small',{'aria-live':'off'},[step,job?.at?'已用 '+Math.max(0,Math.floor((Date.now()-job.at)/1000))+' 秒':''].filter(Boolean).join(' · '))):
            issue?h('div',{className:'rs-board-empty',role:'alert'},reviewIcon(t.icon,28),h('b',null,'转换需要处理'),h('small',null,issue)):
            boardId?studioButton(h('img',{src:src(boardId),alt:t.sheet}),()=>{V(boardId);Z(false)},'cp-board-view'):h('div',{className:'rs-board-empty'},reviewIcon(t.icon,28),h('b',null,'待生成一张'+t.sheet),h('small',null,t.views))),
          h('p',{className:'rs-hint'},active?(stateUnavailable?'暂时无法读取最新进度，连接恢复后会自动更新。':'可切换到其他页面，返回后查看进度。'):prior?.status==='generated'?'已保留上次转换稿。选择相同原图和制图要求即可取回。'+(prior.instructions?' 上次要求：'+prior.instructions:''):t.hint))),
      h('details',{className:'rs-prompts',key:materialKind},h('summary',null,'转换提示词'),h('p',null,plan.source),h('h4',null,'识别规则'),h('pre',null,plan.analysis),h('h4',null,'制图规则'),h('pre',null,plan.sheet)),
      item?.draftId?h('fieldset',{className:'rs-review',disabled:active,style:{border:0,padding:0,margin:0,minWidth:0},'aria-label':'识别与采用'},h('div',{className:'rs-review-head'},h('div',null,h('h3',null,'核对识别结果'),h('p',null,'可对照参考原图和转换稿，修改识别出的字段。'))),
        studioFields(item.metadata,v=>update({metadata:{...item.metadata,...v},overrides:{...item.overrides,...v}})),h('div',{className:'rs-revise'},studioField('制图修订要求',input(item.instructions,v=>update({instructions:v,requestId:crypto.randomUUID()}),'例如：保留领口花边，补清侧面结构')),studioButton('按要求重新生成',convertSources)),
        h('div',{className:'rs-adopt'},h('details',{className:'rs-save-prefs'},h('summary',null,h('strong',null,'保存选项'),h('small',null,list.find(x=>x.id===item.targetId)?.name||'新建素材')),h('div',{className:'rs-target'},choose('保存到',item.targetId,v=>update({targetId:v}),[['','新建素材'],...list.filter(x=>x.id).map(x=>[x.id,x.name])]),choose('素材封面',item.coverChoice,v=>update({coverChoice:v}),saveOptions),choose('拍摄取用',item.useBoard?'board':'source',v=>update({useBoard:v==='board'}),saveOptions),materialKind==='identity'?choose('本人物拍照参考',item.asMain?'main':'library',v=>update({asMain:v==='main'}),[['main','当前人设图'],['library','仅存入素材库']]):null)),
          h('div',{className:'rs-save-actions'},h('label',{className:'rs-check'},h('input',{type:'checkbox',checked:item.keepOriginal,onChange:e=>update({keepOriginal:e.target.checked,useBoard:!e.target.checked||item.useBoard,coverChoice:e.target.checked?item.coverChoice:'board'})}),'同时保存原图'),studioButton('确认入库',adoptSources,'btn primary',!item.metadata.name?.trim()||!item.metadata.description?.trim())))):null)
  }  function editPhoto(p,discard=false){EE(p.id);ED(e=>e[p.id]?.touched&&!discard?e:{...e,[p.id]:{personaId:persona,photoId:p.id,title:p.title||'',caption:p.caption||'',aliases:p.aliases||'',tags:p.tags||'',useCases:p.useCases||'',subjectIsRole:p.subjectIsRole===true,revision:Number(p.annotationRevision||0)}})}
  function photoIdentity(p){const name=data.profiles.find(x=>x.id===p.profileId)?.name||p.identityContext?.name;return name?((p.subjectIsRole===true?'画面主角：':'所属相册：')+name):'未关联角色相册'}
  function changePhoto(patch){ED(e=>({...e,[editor]:{...e[editor],...patch,touched:true}}));DI(true)}
  async function generate(shotFrame=framing){
    if(dirty)throw Error('请先保存设定和配置，再生成预览。')
    const ordinary=['environment','object'].includes(shotFrame)
    const materialIds=selectedMaterials.filter(id=>!ordinary||data.managedMaterials?.some(m=>m.id===id&&m.kind!=='identity'))
    const r=await call('/generate-preview',{request,shape,shotStyle,sceneMode,scene:sceneMode==='custom'&&cameraPlace.trim()?{location:cameraPlace.trim()}:undefined,
      subject:ordinary?'ordinary':'character',framing:shotFrame,keywords,materialIds,textOnlyMaterialIds:textMaterials.filter(id=>materialIds.includes(id)),
      outfitId:ordinary||wear==='custom'?'':wear,outfitMode:wear==='custom'?'custom':'',previousPhotoId:reference,requestId:crypto.randomUUID()})
    if(!r.ok)return r
    PJ(r.jobId||'');PI(r.photo?.id||'');await load();return r
  }
  if(!data)return h('div',{className:'cp-panel'},h('style',null,css+wordStyle+moduleStyle+relationshipStyles()+'.cp-preset-card{display:grid;gap:6px;text-align:left;align-content:start;padding:12px;background:transparent;color:inherit;border:1px solid #cdd6df;border-radius:8px;cursor:pointer}.cp-preset-card span{font-size:.9em}.cp-preset-card:hover,.cp-preset-card:focus-visible{border-color:#4181cc}'),h('p',null,message||'正在加载模拟人生5…'))
  const lifeView=lifeViews[persona],lifeCfg=lifeDrafts[persona]?.config||lifeView?.config
  const role=roleFor(persona),active=data.profiles.find(p=>p.id===data.activeProfileId),photo=data.photos.find(p=>p.id===(data.jobs.find(j=>j.id===previewJob)?.photoId||previewId)),job=data.jobs.find(j=>j.id===previewJob),edit=edits[editor]
  const existingPhotos=data.photos.filter(p=>!deletePhotos.includes(p.id)),needSave=(dirty||relationPending)?hint('有未保存的修改，请使用顶部“保存设置”。'):null
  const viewReady=!persona||albumPersona===(tab==='photo'?data.personaId:persona)
  const framingNames={portrait:'人物生活照',selfie:'自拍',environment:'环境',object:'物件'}
  const mediaSources={panel:'面板试拍',chat:'聊天',proactive:'角色主动',diary:'空间日记',material:'素材转换',upload:'上传照片',native:'聊天画作',sample:'参考样图'}
  const mediaJobs=new Map(data.jobs.map(j=>[j.id,j]))
  const photoForJob=new Map(existingPhotos.filter(p=>p.jobId).map(p=>[p.jobId,p]))
  const photoOrigin=p=>p.origin||mediaJobs.get(p.jobId)?.origin||p.source
  const photoFrame=p=>p.framing||mediaJobs.get(p.jobId)?.composition?.kind
  const photoCategory=p=>p.source==='upload'?'upload':p.source==='sample'?'sample':photoOrigin(p)==='panel'?'panel':'result'
  const albumFilters=[['','全部'],['upload','上传照片'],['sample','参考样图'],['panel','面板试拍'],['result','正式成片'],...Object.entries(framingNames)]
  const photoTitle=p=>edits[p.id]?.title||p.title||p.request||mediaSources[photoOrigin(p)]||'相册照片'
  const albumTerm=albumSearch.trim().toLocaleLowerCase()
  const filteredPhotos=existingPhotos.filter(p=>{
    if(albumKind&&photoCategory(p)!==albumKind&&photoFrame(p)!==albumKind)return false
    const v={...p,...edits[p.id]}
    return [photoTitle(p),v.caption,v.tags,v.aliases,v.useCases].some(x=>String(x||'').toLocaleLowerCase().includes(albumTerm))
  })
  const jobStates={queued:'处理中',planning:'处理中',generating:'处理中',sending:'处理中',generated:'完成',sent:'完成',reused:'已复用',skipped:'已跳过',cancelled:'已取消',unknown:'待核对',failed:'失败'}
  const statusOf=j=>jobStates[j.status]||j.status||'待核对'
  const statusTone=s=>({'完成':'good','已复用':'good','待核对':'wait','处理中':'wait','失败':'fail'}[s]||'')
  const filteredJobs=data.jobs.filter(j=>(!recordKind||j.origin===recordKind||j.stage===recordKind)&&(!jobFilter||statusOf(j)===jobFilter))
  const galleryPage=pageOf(filteredPhotos,albumPage,albumSize),recordPage=pageOf(filteredJobs,jobsPage,jobsSize)
  function mediaField(label,control,extra=''){return h('label',{className:'md-field '+extra},label,control)}
  function mediaSelect(label,value,options,change){
    return mediaField(label,h('select',{value,onChange:e=>change(e.target.value)},...options.map(([key,name])=>h('option',{key,value:key},name))))
  }
  function mediaInfo(items){
    return h('dl',{className:'md-info'},...items.filter(([,value])=>value).map(([label,value])=>h('div',{key:label},h('dt',null,label),h('dd',null,value))))
  }
  function mediaHeader(title,icon,actions){
    return h('header',{className:'md-pagehead'},h('h2',{className:'md-collection-title'},h('span',{className:'md-collection-icon'},reviewIcon(icon,18)),title),actions)
  }
  function mediaDialog(title,onDismiss,body){
    return h('dialog',{className:'md-dialog',ref:d=>{if(d&&!d.open)d.showModal()},'aria-labelledby':'cp-media-dialog-title',onCancel:e=>{e.preventDefault();onDismiss()},onClick:e=>{
      if(e.target!==e.currentTarget)return
      const box=e.currentTarget.getBoundingClientRect()
      if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)onDismiss()
    }},h('div',{className:'md-dialog-head'},h('h2',{id:'cp-media-dialog-title'},title),btn('关闭',onDismiss)),body)
  }
  function mediaDate(at,options={}){
    if(!at||!Number.isFinite(new Date(at).getTime()))return ''
    return new Date(at).toLocaleString('zh-CN',{timeZone:cfg.timezone||undefined,hour12:false,...options})
  }
  function openAlbumPhoto(p){setAlbumFeedback('');setOpenJob('');editPhoto(p);T('gallery')}
  function openMediaJob(j){EE('');showInbox(false);setOpenJob(j.id);T('jobs')}
  function fullMediaImage(id){EE('');setOpenJob('');V(id);Z(false)}
  async function uploadAlbumPhoto(file){
    if(dirty)throw Error('请先通过顶部保存当前修改，再上传照片。')
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||!file.size)throw Error('请选择 JPG、PNG 或 WebP 图片。')
    const r=await call('/import-photo',{personaId:albumPersona,profileId:albumProfile,base64:await readFile(file),name:file.name})
    if(!r.ok)return r
    const refreshed=await load(true)
    if(refreshed){setAlbumSearch('');setAlbumKind('upload');AP(1);openAlbumPhoto(r.photo)}
    return r
  }
  async function describeAlbumPhoto(){
    try{
      const result=await call('/describe-photo',{personaId:persona,photoId:editor,subjectIsRole:edit.subjectIsRole===true})
      if(!result.ok)throw Error(result.message||'识别未完成。')
      changePhoto(result.suggestion);setAlbumFeedback('AI 注释已填入，请核对后保存。')
    }catch(err){setAlbumFeedback(err.message)}
  }
  function otherSettingsPending(){
    return Boolean(Object.entries(edits).some(([id,note])=>id!==editor&&note.touched)||deletePhotos.length||deleteAssets.length||Object.keys(roles).length||Object.keys(lifeDrafts).length||JSON.stringify(cfg)!==JSON.stringify(settingsBaseline.current))
  }
  async function saveAlbumNote(){
    try{
      // Only this photograph is changing. Its annotation revision protects simultaneous edits.
      const result=await call('/save-all',{personaId:persona,photoEdits:[edit]})
      if(!result.ok)throw Error(result.message||'照片注释保存失败。')
      const refreshed=await load()
      if(!refreshed)return
      const saved=refreshed.photos.find(p=>p.id===editor)
      ED(previous=>({...previous,[editor]:{...edit,revision:saved?.annotationRevision??(edit.revision+1),touched:false}}))
      DI(otherSettingsPending());setAlbumFeedback('照片注释已保存。')
    }catch(err){setAlbumFeedback(err.message);await load()}
  }
  function albumDetail(p){
    const source=photoOrigin(p),category=albumFilters.find(([k])=>k===photoCategory(p))?.[1]
    const j=mediaJobs.get(p.jobId)||data.jobs.find(x=>x.photoId===p.id)
    const annotation=({ready:'已完成 AI 注释',manual:'手动注释',pending:'AI 注释处理中',unknown:'AI 注释结果待核对',failed:'AI 注释未完成，可手动重试'})[p.annotationStatus]||'可手动补充或使用 AI 注释'
    return mediaDialog(photoTitle(p),()=>EE(''),h('div',{className:'md-shot-detail'},
      h('div',{className:'md-shot-image'},p.assetId?h('img',{src:src(p.assetId),alt:photoTitle(p)}):reviewIcon('image',24)),
      h('div',{className:'md-shot-meta'},
        mediaInfo([['类别',category],['取景',framingNames[photoFrame(p)]],['来源',mediaSources[source]],['记录时间',mediaDate(p.at)],['相册',photoIdentity(p)],['画面比例',data.photoAspects?.[p.shape]]]),
        p.aspectNote?h('p',{className:'md-help'},p.aspectNote):null,
        h('div',{className:'md-actions cp-note-tools'},btn('查看原图',()=>fullMediaImage(p.assetId),!p.assetId),btn('AI 注释',describeAlbumPhoto),h('small',{className:'md-help'},annotation)),
        edit.touched&&edit.revision!==Number(p.annotationRevision||0)?h('div',{className:'md-actions cp-note-tools'},h('span',{className:'md-help',role:'status'},'此注释已在别处更新，当前草稿仍保留。'),btn('放弃此草稿并载入最新注释',()=>{editPhoto(p,true);DI(otherSettingsPending());setAlbumFeedback('已载入最新注释。')})):null,
        h('div',{className:'md-editgrid'},...[['title','标题'],['aliases','别名'],['tags','标签'],['useCases','适用语境']].map(([key,label])=>h('label',{className:'md-field',key},label,h('input',{value:edit[key],onChange:e=>changePhoto({[key]:e.target.value})})))),
        mediaField('画面内容与外观描述',h('textarea',{rows:3,value:edit.caption,placeholder:'写下这张照片里的细节',onChange:e=>changePhoto({caption:e.target.value})})),
        h('label',{className:'cp-note-main'},h('input',{type:'checkbox',checked:edit.subjectIsRole===true,onChange:e=>changePhoto({subjectIsRole:e.target.checked})}),'画面主角是此相册所属角色'),
        h('div',{className:'md-actions'},btn('保存注释',saveAlbumNote,!edit.touched,true),j?btn('查看拍摄记录',()=>openMediaJob(j)):null,btn('删除',()=>{
          DP(ids=>[...ids,p.id]);DI(true);EE('');notify('照片已标记删除，顶部保存后删除文件。')
        })),h('p',{className:'md-help',role:'status'},albumFeedback))))
  }
  function albumPanel(){
    const selected=existingPhotos.find(p=>p.id===editor)
    return h('div',{className:'ab-card md-page','data-page':'album'},
      mediaHeader('相册','image',h('div',{className:'md-actions'},btn('去拍照',()=>T('photo')),btn('上传照片',()=>albumUpload.current?.click(),!albumProfile,true),
        h('input',{ref:albumUpload,type:'file',accept:'image/png,image/jpeg,image/webp',hidden:true,onChange:e=>{const file=e.target.files?.[0];e.target.value='';if(file)run(()=>uploadAlbumPhoto(file))}}))),
      h('div',{className:'md-filters','aria-label':'相册分类'},...albumFilters.map(([key,label])=>h('button',{type:'button',key,className:'ab-btn md-choice'+(key===albumKind?' is-on':''),'aria-pressed':key===albumKind,onClick:()=>{setAlbumKind(key);AP(1)}},label))),
      mediaField('搜索相册',h('input',{type:'text',value:albumSearch,placeholder:'标题、别名、标签或画面描述',onChange:e=>{setAlbumSearch(e.target.value);AP(1)}}),'md-album-search'),
      annotationCheckError?h('p',{className:'md-help',role:'alert'},annotationCheckError):null,
      galleryPage.items.length?h('div',{className:'md-gallery'},...galleryPage.items.map(p=>{
        const category=albumFilters.find(([k])=>k===photoCategory(p))?.[1]
        return h('button',{key:p.id,type:'button',className:'md-print',onClick:()=>openAlbumPhoto(p)},
          h('span',{className:'md-print-image'},p.assetId?h('img',{src:src(p.assetId),alt:photoTitle(p),loading:'lazy'}):reviewIcon('image',24)),
          h('span',{className:'md-print-info'},h('strong',null,photoTitle(p)),h('small',null,[framingNames[photoFrame(p)],category].filter(Boolean).join(' · '))))
      })):h('div',{className:'md-empty'},albumTerm?'没有匹配的照片':albumKind?'此分类暂无图片':albumProfile?'还没有图片，可以上传已有照片或去拍照。':h(React.Fragment,null,h('p',null,'还没有图片。请先在设定中为此人格保存主设定图，绑定后即可上传。'),btn('去设定',()=>{setMaterialKind('identity');setMaterialIndex(0);T('setup')}))),
      galleryPage.pages>1?pager(galleryPage,albumSize,AS,AP,[6,12,24],'相册分页'):null,
      selected&&edit?albumDetail(selected):null)
  }
  const materialStages={'studio-draft':'设定图转换','identity-convert':'人设三视图转换',analyze:'素材识别',board:'素材制版',collect:'聊天收藏'}
  const jobKind=j=>materialStages[j.stage]||framingNames[j.composition?.kind]||(j.origin==='material'?'素材处理':'拍照')
  const jobTitle=j=>j.metadata?.name||j.request||jobKind(j)
  function resultPhoto(j){return photoForJob.get(j.id)||existingPhotos.find(p=>p.id===j.photoId)}
  function jobDetail(j){
    const shot=resultPhoto(j),status=statusOf(j),version=data.versions.find(v=>v.id===j.versionId)
    const audience=j.chatId?.startsWith('group:')?'群聊':j.chatId?.startsWith('private:')?'私聊':j.origin==='panel'||j.origin==='material'?'仅自己':''
    const refs=j.refs||[], words=j.composition?.keywords||j.keywords||{}
    return mediaDialog(jobTitle(j),()=>setOpenJob(''),h('div',{className:'md-record-detail'},
      h('div',{className:'md-actions'},h('span',{className:'md-chip'},mediaSources[j.origin]||'拍照'),h('span',{className:'md-badge '+statusTone(status)},status)),
      mediaInfo([['时间',mediaDate(j.at)],['任务',jobKind(j)],['画面比例',j.aspect||data.photoAspects?.[j.shape]],['采用版本',version?.name],['受众',audience],['取景',framingNames[j.composition?.kind||shot?.framing]]]),
      h('h3',null,j.origin==='material'?'转换要求':'本次画面'),h('p',null,j.instructions||j.request||'未填写画面描述。'),
      j.metadata?.description?h('p',{className:'md-help'},j.metadata.description):null,
      Object.keys(words).length?h('div',{className:'md-keytags'},...Object.entries(words).filter(([,v])=>typeof v==='string'&&v).map(([key,v])=>h('span',{className:'md-chip',key},(data.photoWordLabels?.[key]||key)+' · '+v))):null,
      h('h3',null,'当时的参考'),refs.length?h('ul',{className:'md-refs'},...refs.map((ref,i)=>{
        const a=data.assets.find(x=>x.id===ref.id)
        return h('li',{key:i},h('span',null,ref.external?'随消息附图':'参考图'),h('div',null,h('b',null,a?.name||'图片 '+(i+1)),h('small',null,ref.notes||ref.note||'')))
      })):h('p',{className:'md-help'},j.sourceHashes?.length?'使用了 '+j.sourceHashes.length+' 张上传原图。':'此记录没有附加图片参考。'),
      j.error?h('div',{className:'cp-status cp-error'},h('strong',null,j.attempted?'生图请求已提交':j.stage==='intent'?'索图规划阶段':j.stage==='outfit'?'穿搭规划阶段':'任务详情'),h('p',null,jobFailure(j))):null,
      shot?h('div',{className:'md-record-result'},h('img',{src:src(shot.assetId),alt:photoTitle(shot)}),btn('查看相册条目',()=>openAlbumPhoto(shot),false,true)):j.boardId?h('div',{className:'md-record-result'},h('img',{src:src(j.boardId),alt:'转换图'}),btn('查看转换图',()=>fullMediaImage(j.boardId))):null))
  }
  function inboxPanel(){
    const c=cfg.privateInbox||{},set=(key,value)=>update('privateInbox',{...c,[key]:value})
    const inboxInput=(key,label,options={})=>mediaField(label,h('input',{name:key,'aria-label':label,value:c[key]??'',...options,onChange:e=>set(key,e.target.value)}))
    return h('div',{className:'ab-card md-page','data-page':'records'},
      mediaHeader('私聊收件箱','book',btn('返回记录',()=>showInbox(false))),
      h('form',{className:'md-inbox-form',onSubmit:e=>{e.preventDefault();run(save)}},
        h('p',{className:'md-help'},'接收 QQ 私聊发来的文件。角色可在主人私聊查找、阅读和回发原件。'),
        inbox?.legacyRunning?h('p',{className:'md-help'},'独立收件箱仍在运行，停用后由本模块接收后续文件。'):null,
        h('div',{className:'md-inbox-fields'},
          mediaSelect('收谁的文件',c.scope||'owner',[['owner','只收主人私聊的'],['all','所有私聊的都收']],v=>set('scope',v)),
          inboxInput('ownerQQ','主人 QQ',{inputMode:'numeric',pattern:'[0-9]{1,20}',placeholder:'留空按宿主设置'}),
          inboxInput('maxMB','单个文件上限（MB）',{type:'number',min:1,max:2048,step:1,required:true}),
          mediaSelect('收下后回一条确认',String(Boolean(c.autoReply)),[['true','开启'],['false','关闭']],v=>set('autoReply',v==='true')),
          inboxInput('exts','只收这些后缀',{placeholder:'留空全收，例如 zip,docx'}),
          inboxInput('ffmpegPath','ffmpeg 路径（选填）',{placeholder:'留空时自动查找'}))),
      h('section',{className:'md-inbox-empty'},h('div',{className:'md-title'},h('h3',null,'收件箱文件'),btn('刷新',refreshInbox)),
        inboxError?h('p',{className:'md-help',role:'alert'},inboxError):null,
        !inbox?h('p',{className:'md-help'},inboxError?'暂时无法读取文件。':'正在读取收件箱…'):inbox.items?.length?inbox.items.map(f=>h('div',{key:f.id,className:'cp-inbox-file'},
          h('div',null,h('b',null,f.name),h('small',null,[f.cat,mediaDate(f.at),f.size+' 字节'].filter(Boolean).join(' · '))),
          h('a',{className:'ab-btn',href:'/aurabot/api/ext/character-photo/inbox/file?download=1&id='+encodeURIComponent(f.id),download:f.name},'下载原件'))):h('p',{className:'md-help'},'等待第一份 QQ 私聊文件。')),
      h('section',{className:'md-inbox-empty'},h('h3',null,'接收记录'),
        inbox?.records?.length?inbox.records.map((r,i)=>h('p',{className:'md-help',key:i},[mediaDate(r.at),r.action,r.name,r.reason].filter(Boolean).join(' · '))):inbox?h('p',{className:'md-help'},'暂无接收记录。'):null))
  }
  function recordPanel(){
    if(inboxView)return inboxPanel()
    const selectStatus=value=>{setJobFilter(value);JP(1)}
    const stats=[['','全部任务'],['完成','已完成'],['待核对','待核对'],['失败','失败']]
    const record=mediaJobs.get(openJob)
    const entries=[]
    let previous=''
    const today=localDate(Date.now(),cfg.timezone)
    for(const j of recordPage.items){
      const when=Number(j.at),day=when?localDate(when,cfg.timezone):'时间未知'
      if(previous!==day){entries.push(h('h3',{key:'day-'+day,className:'md-day'},day===today?'今天':day));previous=day}
      const shot=resultPhoto(j),thumbnail=shot?.assetId||j.boardId,status=statusOf(j),tone=statusTone(status)
      entries.push(h('button',{type:'button',key:j.id,className:'md-log',onClick:()=>openMediaJob(j)},
        h('time',null,when?mediaDate(when,{hour:'2-digit',minute:'2-digit'}):'—'),h('i',{className:'md-dot '+tone}),
        h('span',{className:'md-log-thumb'},thumbnail?h('img',{src:src(thumbnail),alt:'',loading:'lazy'}):reviewIcon(j.origin==='material'?'image':'clock',17)),
        h('span',{className:'md-log-copy'},h('b',null,jobTitle(j)),h('small',null,(mediaSources[j.origin]||'拍照')+' · '+jobKind(j))),
        h('span',{className:'md-badge '+tone},status),h('span',{'aria-hidden':true},'›')))
    }
    const sources=[['','全部'],...['panel','chat','proactive','diary','material'].map(key=>[key,mediaSources[key]]),...Object.entries(materialStages)]
    return h('div',{className:'ab-card md-page','data-page':'records'},
      mediaHeader('记录','book',btn('私聊收件箱',()=>{setOpenJob('');showInbox(true)})),
      h('div',{className:'md-statbar','aria-label':'按任务状态筛选'},...stats.map(([key,label])=>h('button',{type:'button',key,className:'md-stat '+statusTone(key)+(jobFilter===key?' is-on':''),'aria-pressed':jobFilter===key,onClick:()=>selectStatus(key)},h('small',null,label),h('strong',null,key?data.jobs.filter(j=>statusOf(j)===key).length:data.jobs.length)))),
      h('section',{className:'md-logbook'},h('div',{className:'md-log-head'},h('h2',null,'活动流水'),h('div',null,
        mediaSelect('来源',recordKind,sources,v=>{setRecordKind(v);JP(1)}),
        mediaSelect('状态',jobFilter,[['','全部'],...new Set(Object.values(jobStates))].map(v=>Array.isArray(v)?v:[v,v]),selectStatus))),
        entries.length?entries:h('p',{className:'md-empty'},'这组筛选下还没有任务。')),
      recordPage.pages>1?pager(recordPage,jobsSize,JS,JP,[10,20,50],'记录分页'):null,
      data.jobs.length?h('details',{className:'md-explain cp-log-tools'},h('summary',null,'管理记录'),
        h('p',{className:'md-help'},'清空已结束的记录会保留进行中的任务、额度统计和防重复请求记录。'),
        h('div',{className:'md-actions'},btn('刷新状态',()=>load()),btn('清空已结束记录',async()=>{const r=await call('/clear-jobs',{personaId:persona});if(r.ok){setOpenJob('');JP(1);await load()}return r}))):null,
      record?jobDetail(record):null)
  }
  const lines=(v)=>String(v).split('\n').map(x=>x.trim()).filter(Boolean)
  const photoSources=[['panel','面板试拍'],['chat','聊天'],['proactive','角色主动'],['diary','空间日记']]
  function photoRouting(){
    if(cameraOrigin==='proactive')return stack(h('div',{className:'cp-section cp-stack'},h('h4',{className:'cp-subtitle'},'主动搭话附图'),grid(field('允许主动附图',bool(cfg.proactive,v=>update('proactive',v))),field('附图概率（%）',input(cfg.proactiveChance,v=>update('proactiveChance',Number(v)),'0–100','number'))),grid(field('图片来源',select(cfg.proactiveSource,v=>update('proactiveSource',v),[['album','只选相册已有图片'],['generate','即时生成角色照片'],['mixed','随机选择相册或即时生成']])),field('主动附图最短间隔（分钟）',input(cfg.proactiveCooldownMinutes,v=>update('proactiveCooldownMinutes',Number(v)),'','number'))),hint('先按概率决定是否尝试，再根据语境匹配；随机来源各占一半，没有合适旧图时不强行附图。沿用原主动联系来源、静音与清醒时段。'),row(btn('立即测试主动附图',async()=>{if(dirty)throw new Error('请先保存设置');const r=await call('/test-proactive',{requestId:crypto.randomUUID()});if(r.ok){T('jobs');await load()}return r},!cfg.proactive||!cfg.enabled)),hint('测试直接按所选来源准备一张图，跳过概率、配图适宜判断和两类冷却，仍遵守每日额度、静音与清醒时段。成功后会给主人发送文字和图片；调用聊天或生图模型会使用对应额度。')),hint(data.lastProactive?'最近一次自动附图判断 · '+new Date(data.lastProactive.at).toLocaleString()+' · '+data.lastProactive.label:'尚无自动附图判断记录。原生主动搭话进入配图环节后会在这里显示结果。'))
    if(cameraOrigin==='diary')return h('div',{className:'cp-section cp-stack'},h('h4',{className:'cp-subtitle'},'空间日记配图'),grid(field('提供日记配图',bool(cfg.diary,v=>update('diary',v))),field('配图策略',select(cfg.diaryPolicy,v=>update('diaryPolicy',v),[['reuse-first','优先相册，否则根据配文生成'],['reuse','仅复用相册图片'],['generate','根据配文生成新图']]))),field('配图失败时',select(cfg.diaryFailure,v=>update('diaryFailure',v),[['hold','保留草稿，不发布'],['text','允许原日记按纯文字继续']])),hint('相册图片默认可供聊天、拍照参考和日记选用。日记正文、时间、可见范围及发布继续在“平台 → 空间日记”设置；无需配置本地图片目录。'),!data.diaryReady||!data.readiness?.diaryEnabled||!data.readiness?.diaryRich?hint('如需日记配图，请在原空间日记开启“空间日记”和“图文日记与预览”。'):null)
    return section('聊天中索取照片',null,stack(
      field('聊天配图',select(cfg.chatMode,v=>update('chatMode',v),[['explicit','仅在明确索图时'],['smart','结合聊天情境智能适配'],['off','关闭聊天生成']])),
      grid(field('智能聊天配图间隔（分钟）',input(cfg.smartCooldownMinutes,v=>update('smartCooldownMinutes',Number(v)),'','number'))),hint('自拍、本人入镜、眼前环境和手边物件按实际消息辨认。聊天中提供的参考图只用于对应请求。')))
  }
  function cameraPanel(){
    function chatShot(line){
      const q=line.trim()
      if(!q)return {action:'ask',label:'等待补充',note:'填写想试的玩家消息。'}
      const visible=q.replace(/(?:不要|别|不想|不)(?:拍人物|拍人像|拍人|自拍|拍你自己|让人入镜)/g,'')
      if(/(?:不要|不用|别|取消|停止).{0,5}(?:照片|发图|拍照|生图|图片)|只(?:用文字|聊聊|聊天)|仅文字/.test(visible))return {action:'none',label:'文字回应',note:'这句话要求继续文字聊天。'}
      if(/重发|发回原图|再发(?:一次|一遍)?.{0,9}(?:原|旧|刚才|上次|那张)|之前那张/.test(q))return {action:'reuse',label:'重发已有图片',note:'真实聊天从原会话允许的相册记录里匹配，面板可查看已有照片。'}
      if(/合个?影|一起合照|我和你.{0,6}同框|给我拍(?:张|个)(?:照|肖像)|拍我(?:自己|一张|张照)?(?:[，。！!?？]|$)/.test(q))return {action:'reference',label:'需要本轮玩家参考',note:'在 QQ 私聊附上本轮玩家参考图后，可试拍玩家或合影。'}
      if(!/(?:拍|看看|看下|想看|给我看|发[来张个]|照片|自拍)/.test(q))return {action:'none',label:'文字回应',note:'这句话没有明确索图。真实聊天会结合前后文与配图开关判断。'}
      const kind=/自拍|前置镜头/.test(visible)?'selfie':/(?:想看你|看看你|拍你)(?:自己|本人|入镜|现在|在|穿|拿|端|抱|捧|坐|走|的样子|一张|[，。！!？?]|$)|给你拍|角色入镜/.test(visible)?'portrait':/窗外|屋外|街景|房间|海边|四周|风景|环境/.test(visible)?'environment':/杯|书|物件|手边|桌上|蛋糕|花瓶|鞋|物品/.test(visible)?'object':''
      return kind?{action:'new',kind,label:framingNames[kind],note:'面板按这句话试拍。真实聊天会结合当轮上下文判断。'}:{action:'ask',label:'等待补充',note:'补充想拍的人、地点或物件。'}
    }
    function followResult(destination,id){
      if(persona===data.personaId){if(destination==='gallery')openAlbumPhoto(photo);else openMediaJob(job);return}
      if(dirty||relationPending||relationshipEditor.current?.busy){notify('请先保存当前人格的修改。',true);return}
      setCameraLink({persona:data.personaId,tab:destination,id})
      selectPersona(data.personaId);showInbox(false);T(destination)
    }
    const chat=cameraOrigin==='chat'?chatShot(request):null,mode=chat?.kind||framing,noNew=chat&&chat.action!=='new'
    const human=!['environment','object'].includes(mode)
    const modes={portrait:'user',selfie:'camera',environment:'compass',object:'coffee'}
    const originIcons={panel:'camera',chat:'chat',proactive:'send',diary:'book'}
    const kindNames={identity:'人设',outfit:'服饰',scene:'场景',object:'道具'}
    const mainId=data.versions.find(v=>v.id===active?.versionId)?.references?.[0]
    const shelf=(data.managedMaterials||[]).filter(m=>m.profileId===data.activeProfileId&&!m.archived)
    const wardrobe=(data.wardrobe||data.outfits||[]).filter(o=>!o.archived)
    const visual=m=>m?.useBoard&&m.boardId?m.boardId:m?.referenceId
    const selected=shelf.filter(m=>selectedMaterials.includes(m.id)&&(human||m.kind!=='identity'))
    const principal=selected.find(m=>m.kind==='identity')||shelf.find(m=>m.kind==='identity'&&[m.boardId,m.referenceId].includes(mainId))
    const subjectImage=human?visual(principal)||mainId:visual(selected.find(m=>m.kind===(mode==='object'?'object':'scene')&&!textMaterials.includes(m.id)))
    const place=sceneMode==='custom'?cameraPlace.trim()||'自定场景':data.life?.state?.location||'当前生活'
    const refPhoto=existingPhotos.find(p=>p.id===reference)
    const outfit=human&&(wardrobe.find(o=>o.id===wear)||(!wear?(data.currentOutfit||wardrobe.find(o=>o.isDefault)):null))
    const refRows=[]
    if(human&&mainId)refRows.push({name:principal?.name||active?.name||'当前角色',role:'主图',use:'人物身份、比例与画风',image:subjectImage})
    if(outfit)refRows.push({name:outfit.name,role:visual(outfit)?'辅助图':'文字',use:'剪裁、面料与配色',image:visual(outfit)})
    for(const m of selected.filter(x=>x.kind!=='identity')){
      const has=!!visual(m),useImage=has&&!textMaterials.includes(m.id)
      refRows.push({id:m.id,name:m.name,role:useImage?'辅助图':'文字',image:useImage?visual(m):'',canSwitch:has,use:m.kind==='scene'?'空间布局与材质':'物件轮廓与细节'})
    }
    if(refPhoto)refRows.push({name:photoTitle(refPhoto),role:'辅助图',image:refPhoto.assetId,use:'延续相册照片的场景、动作或构图'})
    const references=refRows.filter(r=>r.image).length,aux=refRows.filter(r=>r.role==='辅助图').length
    const warning=!active?'请先在设定中为当前运行人格绑定主设定图。':human&&!subjectImage?'角色入镜需要一张人设图。':human&&data.readiness?.references===false?'请先在「表达 → 生图」启用参考图改画。':(aux>2?'辅助图最多两张，请减少选择或改用文字。':'')
    const action=(text,fn,cls='',props={})=>h('button',{type:'button',className:'ab-btn '+cls,onClick:fn,...props},text)
    const choose=(key,v)=>setKeywords(k=>({...k,[key]:k[key]===v?'':v}))
    const pick=m=>{
      if(m.kind==='outfit'){W(wear===m.id?'':m.id);return}
      setSelectedMaterials(old=>{
        if(old.includes(m.id))return old.filter(id=>id!==m.id)
        const keep=['identity','scene'].includes(m.kind)?old.filter(id=>shelf.find(item=>item.id===id)?.kind!==m.kind):old
        return [...keep,m.id]
      })
    }
    const modeButtons=h('fieldset',{className:'md-subjects'},h('legend',null,'拍什么'),h('div',null,...Object.entries(framingNames).map(([key,label])=>h('button',{type:'button',key,className:'md-subject md-subject-'+key,'aria-pressed':framing===key,onClick:()=>setFraming(key)},reviewIcon(modes[key],18),h('span',null,label)))))
    const words=h('section',{className:'md-word-picker'},h('div',{className:'md-title'},h('h3',null,'画面关键词'),h('small',null,'点选或自填，也可直接写进画面描述')),
      ...Object.entries(data.photoWords||{}).filter(([k])=>human||!['emotion','pose'].includes(k)).map(([key,items])=>h('fieldset',{key},
        h('legend',null,data.photoWordLabels?.[key]||key),h('div',{className:'md-words'},...items.filter(s=>human||key!=='camera'||!['自拍','半身','全身'].includes(s.name)).map(s=>action(s.name,()=>choose(key,s.name),'md-choice'+(keywords[key]===s.name?' is-on':''),{key:s.name,title:s.desc||s.description||s.prompt||s.name,'aria-pressed':keywords[key]===s.name}))),
        h('input',{'aria-label':'自填'+(data.photoWordLabels?.[key]||key),placeholder:'自填',value:keywords[key]||'',onChange:e=>setKeywords({...keywords,[key]:e.target.value})}))))
    const routed=cameraOrigin!=='panel'
    const inputName={panel:'画面描述',chat:'玩家消息',proactive:'想分享的画面',diary:'日记配图描述'}[cameraOrigin]
    const subjects=h('section',{className:'md-compose','aria-label':'拍摄内容'},chat?null:modeButtons,
      mediaField(inputName,h('textarea',{rows:3,'aria-label':inputName,placeholder:chat?'例如：拍一下窗外，别自拍':'描述地点、动作或想拍的细节',value:request,onChange:e=>{const q=e.target.value;Q(q);if(chat){const kind=chatShot(q).kind;if(kind)setFraming(kind)}}})),
      mediaSelect('画面比例',shape,Object.entries(data.photoAspects||{portrait:'2:3',wide:'16:9'}),SH),
      cameraOrigin==='chat'?h('details',{className:'md-samples'},h('summary',null,'试用聊天示例'),h('div',{className:'md-examples'},...
        [['selfie','发张你的自拍'],['portrait','想看你端着杯子的样子'],['environment','拍一下窗外，别自拍'],['object','拍你手边的杯子，不拍人'],['','不要图片，只聊聊'],['','再发一次刚才那张'],['','我们合个影'],['','给我拍张照']].map(([kind,prompt])=>action(prompt,()=>{Q(prompt);if(kind)setFraming(kind)},'md-example',{key:prompt})))):null)
    const pending=job&&['queued','generating','planning','sending'].includes(job.status)
    const result=h('aside',{className:'md-shot-result','aria-label':'取景与结果'},h('div',{className:'md-result-head'},h('div',null,h('small',null,'本次取景'),h('h3',null,chat?.label||framingNames[mode])),h('span',{className:'md-audience'},'仅自己')),
      noNew?null:h('div',{className:'md-frame',style:{aspectRatio:(data.photoAspects?.[shape]||'2:3').replace(':','/')}},
        photo?h('img',{src:src(photo.assetId),alt:'拍摄结果',onClick:()=>fullMediaImage(photo.assetId)}):subjectImage?h('img',{src:src(subjectImage),alt:principal&&human?principal.name:'本次取景参考'}):h('span',{className:'md-image-empty'},reviewIcon(modes[mode],23),h('small',null,human?'尚未绑定人设图':mode==='object'?'尚未选用物件图片':'当前地点尚未绑定场景图'))),
      noNew?null:h('div',{className:'md-frame-note'},reviewIcon('map-pin',13),h('span',null,place),h('span',null,photo?'拍摄结果':human&&principal?principal.name:subjectImage?'已绑定参考图':'文字取景')),
      chat?h('p',{className:'md-reason','aria-live':'polite'},chat.note):null,
      !noNew&&warning?h('p',{className:'md-warning',role:'status'},warning):null,
      noNew?(chat.action==='reuse'?action('查看已有照片',()=>T('gallery'),'md-link'):null):h('div',{className:'md-result-action'},action(pending?'生成中…':photo?'重新生成':'生成预览',()=>run(()=>generate(mode)),'primary md-shoot',{disabled:busy||pending||!request.trim()||!cfg.enabled||!!warning,title:'使用生图额度，成功后自动入册'}),h('small',null,'仅入相册')),
      job?h('div',{className:'md-receipt',role:'status'},h('span',null,job.error?jobFailure(job):jobLabel(job)),action('查看记录',()=>followResult('jobs',job.id),'md-link')):null,
      photo?action('查看成片与注释',()=>followResult('gallery',photo.id),'md-link'):null)
    const shelfRows=[...shelf,...wardrobe.map(o=>({...o,kind:'outfit'}))].filter(m=>human||!['identity','outfit'].includes(m.kind))
    const library=h('section',{className:'md-sheet'},h('div',{className:'md-title'},h('h3',null,'拍摄素材'),h('span',null,human?'1 张主图，最多 2 张辅助图':'最多 2 张辅助图')),
      h('div',{className:'md-assets'},...shelfRows.map(m=>{
        const picked=m.kind==='outfit'?outfit?.id===m.id:m.kind==='identity'?principal?.id===m.id:selectedMaterials.includes(m.id)
        return h('button',{type:'button',key:m.id,className:'md-asset'+(picked?' is-picked':''),'aria-pressed':picked,onClick:()=>pick(m)},visual(m)?h('img',{src:src(visual(m)),alt:''}):reviewIcon('image',19),h('span',null,h('small',null,kindNames[m.kind]),h('strong',null,m.name)),h('b',{'aria-hidden':true},picked?'✓':'+'))
      })),!shelfRows.length?h('p',{className:'md-help'},'当前分类还没有可用素材。'):null,action('去设定管理素材',()=>T('setup'),'md-link'))
    const recipe=h('section',{className:'md-sheet'},h('div',{className:'md-title'},h('h3',null,'实际参考'),h('span',null,references+' 张图')),
      refRows.length?h('ul',{className:'md-refs'},...refRows.map((r,i)=>h('li',{key:r.id||i},h('span',null,r.role),h('div',null,h('b',null,r.name),h('small',null,r.use)),r.canSwitch?action(r.image?'改用文字':'改用图',()=>setTextMaterials(old=>old.includes(r.id)?old.filter(id=>id!==r.id):[...old,r.id]),'md-mini'):null))):h('p',{className:'md-help'},'本次从画面描述与现场光线构图。'),
      h('details',{className:'md-explain'},h('summary',null,'取材顺序与受众'),h('p',null,'聊天按当轮索图意图和接收范围决定是否重发、生成或继续文字。环境与物件省略人设、穿搭及人物动作。')))
    const tuning=h('details',{className:'md-tuning-fold'},h('summary',null,reviewIcon('sliders',17),h('strong',null,'调整素材与镜头'),h('small',null,references+' 张参考图')),
      h('div',{className:'md-tuning-grid'},h('div',null,library,recipe),h('section',{className:'md-sheet'},h('div',{className:'md-title'},h('h3',null,'地点与镜头')),
        h('div',{className:'md-editgrid'},mediaSelect('场景来源',sceneMode,[['current','当前生活'],['custom','自定场景']],setSceneMode),sceneMode==='custom'?mediaField('拍摄地点',h('input',{value:cameraPlace,placeholder:'例如：旧书店的窗边',onChange:e=>setCameraPlace(e.target.value)})):null,
          human?mediaSelect('穿搭',wear,[['','按活动与场合挑选'],...wardrobe.map(o=>[o.id,o.name]),['custom','写在画面描述中']],W):null,
          mediaSelect('照片风格',shotStyle,[['auto','自动'],['portrait','自然人像'],['detail','近景细节']],setShotStyle),
          mediaSelect('相册场景参考',reference,[['','不使用相册参考'],...existingPhotos.filter(p=>p.allowReference!==false).map(p=>[p.id,photoTitle(p)])],REF)),
        btn('AI 优化画面描述',async()=>{if(dirty)throw Error('请先保存修改');const r=await call('/optimize-prompt',{request,framing});if(r.ok)Q(r.request);return r},!request.trim()))))
    return h('div',{className:'ab-card md-page md-camera','data-page':'photo'},h('header',{className:'md-pagehead'},h('div',{className:'md-camera-title'},h('span',{className:'md-camera-icon'},reviewIcon('camera',19)),h('h2',null,'拍照'),
      h('label',{className:'md-origin'},reviewIcon(originIcons[cameraOrigin],15),h('select',{'aria-label':'拍照来源',value:cameraOrigin,onChange:e=>setCameraOrigin(e.target.value)},...photoSources.map(([id,name])=>h('option',{key:id,value:id},name))))),action('打开相册',()=>T('gallery'),'md-link')),
      h('div',{className:'md-studio'},subjects,result),h('div',{className:'md-pickers'},words),h('div',{className:'md-tuning'},tuning),
      routed?h('details',{className:'md-tuning-fold',key:cameraOrigin},h('summary',null,reviewIcon(originIcons[cameraOrigin],17),h('strong',null,{chat:'聊天配图',proactive:'主动搭话附图',diary:'空间日记配图'}[cameraOrigin])),h('div',{className:'md-sheet cp-route-settings'},photoRouting())):null)
  }
  function openPersonaCard(){
    if(dirty)throw Error('请先保存当前修改，再打开人格卡。')
    const accepted=!document.dispatchEvent(new CustomEvent('aurabot:open-persona',{detail:{id:persona},cancelable:true}))
    if(!accepted)throw Error('请从「人设 → 人格」打开这张卡。')
  }
  function materialLibrary(){
    const names={identity:'人设图',outfit:'服饰（衣柜）',scene:'场景图',object:'道具'}
    const clothes=materialKind==='outfit'
    const list=clothes?role.outfits:(role.materials||[]).filter(m=>m.kind===materialKind)
    const index=materialIndex
    const choose=setMaterialIndex, m=list[index]
    function change(list,extra={}){
      changeRole(clothes?{outfits:list,...extra}:{materials:[...(role.materials||[]).filter(x=>x.kind!==materialKind),...list],...extra})
    }
    const patch=value=>change(list.map((x,i)=>i===index?{...x,...value}:x))
    async function process(op,analyzeBoard=false){
      if(dirty||!m?.id)throw Error('请先保存当前素材')
      const r=await call('/material-process',{revision:revision.current,op,analyzeBoard,kind:materialKind,id:m.id,profileId:role.profileId,requestId:crypto.randomUUID()})
      await load(true);return r
    }
    function remove(){
      const extra={}
      if(clothes && /^\d+$/.test(role.defaultOutfit)){
        const defaultIndex=Number(role.defaultOutfit)
        extra.defaultOutfit=defaultIndex===index?'auto':String(defaultIndex>index?defaultIndex-1:defaultIndex)
      }
      change(list.filter((_,i)=>i!==index),extra);choose(0)
    }
    const t=materialTypes[materialKind], thumb=x=>x.coverId||x.boardId||x.referenceId
    const legacyMain=materialKind==='identity'&&role.mainId&&!list.some(x=>[x.boardId,x.referenceId,x.coverId].includes(role.mainId))
    const count=list.length+(legacyMain?1:0), query=materialSearch.trim().toLowerCase()
    const matches=x=>[x.name,x.aliases,x.tags].join(' ').toLowerCase().includes(query)
    const currentName=data.assets.find(a=>a.id===role.mainId)?.name||data.profiles.find(p=>p.id===role.profileId)?.name||'当前人设图'
    const cards=list.map((x,i)=>matches(x)?h('article',{key:x.id||i,className:'rs-item'},
      h('div',{className:'rs-thumb'},thumb(x)?h('img',{src:src(thumb(x)),alt:x.name||t.label}):reviewIcon(t.icon)),
      h('div',null,h('h4',null,x.name||t.label,materialKind==='identity'&&role.mainId&&[x.boardId,x.referenceId,x.coverId].includes(role.mainId)?h('small',null,'当前人设图'):clothes&&x.id===data.currentOutfit?.id?h('small',null,'正穿着'):null),h('p',null,x.tags||x.description),h('span',{className:'rs-item-actions'},studioButton('编辑',()=>{choose(i);setMaterialEditing(true)},'rs-link'),uploadSources('重新制图',x.id)))):null)
    if(legacyMain&&matches({name:currentName}))cards.unshift(h('article',{className:'rs-item',key:'main'},h('div',{className:'rs-thumb'},h('img',{src:src(role.mainId),alt:'当前人设图'})),h('div',null,h('h4',null,currentName,h('small',null,'当前人设图')),h('span',{className:'rs-item-actions'},studioButton('查看主图',()=>{V(role.mainId);Z(false)},'rs-link')))))
    return h(React.Fragment,null,materialStudio(list),
      clothes?h('details',{className:'card rs-wardrobe'},h('summary',null,h('strong',null,'情境穿搭'),h('small',null,'按活动指定服饰')),h('div',{className:'rs-occasion-grid'},studioField('默认装扮',select(role.defaultOutfit||'auto',v=>changeRole({defaultOutfit:v}),[['auto','按活动和场合挑选'],['original','沿用主设定图原装'],...list.map((o,i)=>[String(i),o.name||'未命名套装'])])),...(data.photoOccasions||[]).map(occasion=>h('label',{className:'rs-field',key:occasion},h('span',{className:'rs-field-label'},occasion),select(role.outfitOccasions?.[occasion]||'',id=>changeRole({outfitOccasions:{...role.outfitOccasions,[occasion]:id}}),[['','自动搭配'],['original','主设定图原装'],...list.filter(o=>o.id).map(o=>[o.id,o.name])]))))):null,
      materialEditing&&m?h('section',{className:'card rs-editor','aria-label':'编辑已存素材'},h('header',{className:'rs-review-head'},h('h3',null,'编辑 · '+(m.name||t.label)),studioButton('收起',()=>setMaterialEditing(false),'rs-link')),studioFields(m,patch),
        h('div',{className:'rs-originals'},...[...new Set([...(m.sourceIds||[]),m.referenceId,m.boardId])].filter(Boolean).map(id=>h('button',{key:id,type:'button',onClick:()=>{V(id);Z(false)}},h('img',{src:src(id),alt:id===m.boardId?'转换稿':'留存原图'}),h('span',null,id===m.boardId?'转换稿':'留存原图')))),
        m.boardId&&m.referenceId?studioField('拍摄取用',select(m.useBoard?'board':'source',v=>patch({useBoard:v==='board'}),[['source','原图'],['board','转换图']])):null,
        m.analysis?h('details',{className:'rs-prompts'},h('summary',null,'识别稿'),hint(m.analysis.description),hint(m.analysis.expression),hint(m.analysis.uncertainties),studioButton('采用识别稿',()=>patch({name:m.analysis.name||m.name,expression:m.analysis.expression||m.expression,description:m.analysis.description,aliases:m.analysis.aliases||m.aliases,tags:m.tags||m.analysis.tags}))):null,
        h('div',{className:'rs-tools'},studioButton('识别素材',()=>process('analyze'),'btn',dirty||!m.id||!!(m.analysis&&m.analysis.sourceId===(m.referenceId||m.boardId||''))),m.boardId&&m.referenceId?studioButton('识别转换稿',()=>process('analyze',true),'btn',dirty||m.analysis?.sourceId===m.boardId):null,!m.boardId?studioButton('生成展示图',()=>process('board'),'btn',dirty||!m.id):null,studioButton('移出此素材',()=>{remove();setMaterialEditing(false)},'rs-link'))):null,
      h('section',{className:'rs-library card'},h('div',{className:'rs-library-head'},h('div',null,h('h2',null,t.label+'素材库'),h('small',null,count+' 项素材')),h('input',{type:'search',value:materialSearch,'aria-label':'搜索素材名、别名或标签',placeholder:'搜索名称、别名、标签',onChange:e=>setMaterialSearch(e.target.value)})),h('div',{className:'rs-items'},...cards),!cards.some(Boolean)?h('p',{className:'rs-empty'},count?'没有匹配的素材。':'素材库为空。上传参考图后可在这里保存、编辑。'):null))
  }
  function materialTabs(){
    return h('nav',{className:'rs-collections','aria-label':'素材分类'},...Object.entries(materialTypes).map(([kind,t])=>{
      const list=kind==='outfit'?role.outfits:(role.materials||[]).filter(x=>x.kind===kind)
      const legacy=kind==='identity'&&role.mainId&&!list.some(x=>[x.boardId,x.coverId,x.referenceId].includes(role.mainId))
      return h('button',{key:kind,type:'button','data-role-kind':kind,'aria-pressed':kind===materialKind,disabled:busy,onClick:()=>{if(kind!==materialKind&&identityImport){notify('请先将转换稿入库或清空草稿。',true);return}setMaterialKind(kind);setMaterialIndex(0);setMaterialEditing(false);setMaterialSearch('')}},reviewIcon(t.icon,20),h('strong',null,t.label),h('span',{className:'rs-count'},list.length+(legacy?1:0)))
    }))
  }
  const lifeStatus=()=>lifeError?h('p',{role:'alert',className:'cp-hint'},lifeError):lifeView?.reason?h('p',{role:'status',className:'cp-hint'},lifeView.reason):null
  function section(title,action,content){
    return h('section',{className:'cp-section cp-stack'},h('div',{className:'cp-row cp-title-row'},h('h4',{className:'cp-subtitle'},badgeIcon(title),title),action),content)
  }
  const toggle=(label,key)=>h('label',{className:'cp-option'},label,
    h('span',{className:'cp-switch'},h('input',{type:'checkbox',role:'switch',checked:!!lifeCfg[key],onChange:e=>changeLife({[key]:e.target.checked})})))
  function dayChecks(days,onChange,choices=weekdays){
    return h('div',{className:'cp-field'},h('span',{className:'cp-label'},'适用日期'),
      row(...choices.map(([day,label])=>h('label',{className:'cp-check',key:day},
        h('input',{type:'checkbox',checked:days.includes(day),onChange:e=>onChange(e.target.checked?[...days,day]:days.filter(x=>x!==day))}),label))))
  }
  function blockRows(blocks){
    return h('ul',{className:'cp-agenda'},...blocks.map((b,i)=>h('li',{key:b.id+'-'+i,className:b.ongoing?'cp-now':''},
      h('time',null,(b.dayOffset<0?'昨 ':'')+b.start+'–'+b.end+(b.overnight&&b.dayOffset>=0?' 次日':'')),
      h('div',null,h('strong',null,b.label),b.location?hint(b.location):null),h('small',null,b.ongoing?'进行中':phaseName(b.phase)))))
  }
  function timetableEditor(){
    const changeBlock=(index,value)=>changeLife({scheduleBlocks:lifeCfg.scheduleBlocks.map((block,i)=>i===index?{...block,...value}:block)})
    const setMode=scheduleMode=>{
      if(scheduleMode==='basic'){changeLife({scheduleMode});return}
      const count=scheduleMode==='rotation'?lifeCfg.rotationDays:7
      const days=Array.from({length:count},(_,i)=>i)
      const seed=[{id:crypto.randomUUID(),phase:'sleep',days,start:lifeCfg.sleepStart,end:lifeCfg.wakeTime,label:'睡眠',location:''}]
      if(lifeCfg.workEnabled)seed.push({id:crypto.randomUUID(),phase:'work',days:scheduleMode==='weekly'?lifeCfg.workDays:[0],start:lifeCfg.workStart,end:lifeCfg.workEnd,label:lifeCfg.workLabel,location:lifeCfg.workPlace})
      changeLife({scheduleMode,scheduleBlocks:lifeCfg.scheduleBlocks.length?lifeCfg.scheduleBlocks:seed})
    }
    const days=lifeCfg.scheduleMode==='rotation'?Array.from({length:lifeCfg.rotationDays},(_,i)=>[i,'第 '+(i+1)+' 天']):weekdays
    return stack(
      grid(field('日程方式',select(lifeCfg.scheduleMode,setMode,timetableModes)),
        field('作息弹性',select(lifeCfg.mode,v=>changeLife({mode:v}),[['fixed','固定'],['flexible','睡眠小幅浮动']]))),
      lifeCfg.mode==='flexible'?field('前后浮动（分钟）',input(lifeCfg.flexMinutes,v=>changeLife({flexMinutes:Number(v)}),'0–60','number'),'同一晚的安排固定，刷新不会重抽。'):null,
      lifeCfg.scheduleMode==='basic'?stack(
        grid(field('入睡时间',input(lifeCfg.sleepStart,v=>changeLife({sleepStart:v}),'','time')),field('起床时间',input(lifeCfg.wakeTime,v=>changeLife({wakeTime:v}),'','time'))),
        field('固定工作或学习时段',bool(lifeCfg.workEnabled,v=>changeLife({workEnabled:v}))),
        lifeCfg.workEnabled?stack(
          grid(field('开始',input(lifeCfg.workStart,v=>changeLife({workStart:v}),'','time')),field('结束',input(lifeCfg.workEnd,v=>changeLife({workEnd:v}),'','time'))),
          field('工作或学习说明',input(lifeCfg.workLabel,v=>changeLife({workLabel:v}))),
          dayChecks(lifeCfg.workDays,workDays=>changeLife({workDays}))):null
      ):stack(
        lifeCfg.scheduleMode==='rotation'?grid(
          field('轮班第 1 天',input(lifeCfg.scheduleAnchor,v=>changeLife({scheduleAnchor:v}),'','date')),
          field('每轮天数（2–28）',input(lifeCfg.rotationDays,v=>{const n=Number(v);if(n>=2&&n<=28)changeLife({rotationDays:n})},'','number'))):null,
        hint('结束时间早于开始时间时跨到次日。轮班调整后，请核对每个时段的适用日期。'),
        ...lifeCfg.scheduleBlocks.map((b,i)=>h('div',{className:'cp-box',key:b.id},
          grid(field('时段类型',select(b.phase,phase=>changeBlock(i,{phase}),phases.slice(0,4))),
            field('说明',input(b.label,label=>changeBlock(i,{label}),'例如：准备直播'))),
          grid(field('开始时间',input(b.start,start=>changeBlock(i,{start}),'','time')),
            field('结束时间',input(b.end,end=>changeBlock(i,{end}),'','time'))),
          dayChecks(b.days,d=>changeBlock(i,{days:d}),[...days,...b.days.filter(d=>!days.some(([key])=>key===d)).map(d=>[d,'第 '+(d+1)+' 天（超出范围）'])]),
          row(input(b.location,location=>changeBlock(i,{location}),'地点（可选）'),
            btn('删除时段',()=>changeLife({scheduleBlocks:lifeCfg.scheduleBlocks.filter((_,j)=>j!==i)}))))),
        row(btn('添加时段',()=>changeLife({scheduleBlocks:[...lifeCfg.scheduleBlocks,{id:crypto.randomUUID(),phase:'free',days:[lifeCfg.scheduleMode==='rotation'?0:1],start:'12:00',end:'13:00',label:'',location:''}]}),lifeCfg.scheduleBlocks.length>=48))
      )
    )
  }
  function presetEditor(){
    const chosen=Object.values(presetSelection).some(Boolean),p=lifeView.presets
    const groups=[['career','职业班表','careers'],['temperament','闲暇偏好','temperaments'],['lifestyle','生活方式','lifestyles']]
    const preview=pendingPreset?.persona===persona?pendingPreset:null
    return stack(
      field('套用范围',select(scheduleOnly?'schedule':'full',v=>{SO(v==='schedule');PP(null)},[['full','整套生活：班表、空间、兴趣与分享示例'],['schedule','只套作息：保留当前兴趣与空间']]),'预设不会改写人格卡。先预览变更，再应用到草稿，最后点顶部保存。'),
      lifeCfg?.presetVersion===1?row(...[['schedule','升级未手改的原模板班表'],['interests','升级未手改的原模板兴趣']].map(([key,label])=>h('label',{key,className:'cp-check'},h('input',{type:'checkbox',checked:upgradeGroups.includes(key),onChange:e=>{setUpgradeGroups(prev=>e.target.checked?[...prev,key]:prev.filter(k=>k!==key));PP(null)}}),label)),btn('重新对照新版',()=>{const selected={...lifeCfg.presetSelection,...presetSelection};PS(selected);RP(false);return previewPreset(selected,false)},!upgradeGroups.length)):null,
      presetPicker(p),
      h('details',null,h('summary',null,'自行组合预设'),stack(
      h('div',{className:'cp-grid cp-three'},...groups.map(([key,label,group])=>
        field(label,select(presetSelection[key]||'',v=>{PS(all=>({...all,[key]:v}));PP(null)},[['','不选'],...p[group].map(x=>[x.id,x.name])]),
          p[group].find(x=>x.id===presetSelection[key])?.summary))),
      row(h('label',{className:'cp-check'},h('input',{type:'checkbox',checked:replacePreset,onChange:e=>{RP(e.target.checked);PP(null)}}),'替换所选预设涉及的已有字段'),
        btn('预览变更',()=>previewPreset(),!chosen)))),
      undoPreset?.persona===persona?btn('撤销套用',undoAppliedPreset):null,
      preview?h('div',{className:'cp-box',role:'region','aria-label':'预设变更预览'},
        ...preview.warnings.map((message,i)=>h('p',{className:'cp-hint',key:i},message)),
        ...preview.changes.map(({key,before,after})=>key==='scheduleBlocks'
          ?h('div',{key},h('strong',null,'班表'),blockRows(after))
          :h('p',{className:'cp-change',key},presetFields[key]||key,'：',displayValue(key,before),' → ',displayValue(key,after))),
        preview.skipped.length?row(hint('保留已有：'+preview.skipped.map(k=>presetFields[k]||k).join('、')),btn('预览替换已有内容',()=>{RP(true);return previewPreset(presetSelection,true)})):null,
        !preview.changes.length?hint('没有要填入的内容。'):row(btn('套用到草稿',applyPreset,false,true),btn('收起预览',()=>PP(null)))):null)
  }
  function bodyEditor(){
    const setBody=mode=>{
      const patch=({off:{bodyEnabled:false,periodEnabled:false,toiletEnabled:false,detailLevel:'discreet'},
        light:{bodyEnabled:true,toiletEnabled:false,detailLevel:'discreet'},
        detailed:{bodyEnabled:true,toiletEnabled:true,detailLevel:'direct'}})[mode]
      changeLife(patch)
    }
    const custom=lifeCfg.periodMode==='custom'
    return stack(
      row(btn('关闭演绎',()=>setBody('off')),btn('轻量日常',()=>setBody('light')),btn('日常细节',()=>setBody('detailed'))),
      grid(toggle('精力与饥渴','bodyEnabled'),field('睡眠时的回应',
        select(lifeCfg.sleepReply,v=>changeLife({sleepReply:v}),[
          ['natural','自然接话'],['brief','简短回应，保留睡意'],
          ...(lifeView.sleepReady||lifeCfg.sleepReply==='after-wake'?[['after-wake','暂存私聊，醒后回复']]:[]),
        ]))),
      lifeCfg.sleepReply==='after-wake'?grid(
        field('被消息吵醒的概率（%）',input(lifeCfg.sleepWakeChance,v=>changeLife({sleepWakeChance:Number(v)}),'0–100','number'),
          '同一段连续消息共用一次判断。0% 只在作息安排醒来后回复。'),
        hint(lifeView.sleepReady?'适用于获准的 QQ 私聊。主人命令即时处理。':'当前宿主尚未提供醒后处理接口。')):null,
      grid(toggle('经期演绎','periodEnabled'),toggle('如厕演绎','toiletEnabled')),
      lifeCfg.periodEnabled?stack(
        grid(field('虚构周期',select(lifeCfg.periodMode,periodMode=>changeLife({periodMode,periodStart:periodMode==='auto'?'':lifeCfg.periodStart}),[['auto','自动安排'],['custom','自定义日期']])),
          custom?field('起始日期',input(lifeCfg.periodStart,v=>changeLife({periodStart:v}),'','date'))
            :field('开始时的阶段',select(lifeCfg.periodPhase,periodPhase=>changeLife({periodPhase,periodStart:''}),[['auto','自动选择'],['period','从经期开始'],['between','从非经期开始']]))),
        custom?grid(field('周期天数',input(lifeCfg.cycleDays,v=>changeLife({cycleDays:Number(v)}),'','number')),field('持续天数',input(lifeCfg.periodDays,v=>changeLife({periodDays:Number(v)}),'','number'))):null,
        field('经期表现（可选）',input(lifeCfg.periodFeeling,v=>changeLife({periodFeeling:v}),'例如：无明显不适'))):null,
      lifeCfg.periodEnabled||lifeCfg.toiletEnabled?field('细节表达',select(lifeCfg.detailLevel,v=>changeLife({detailLevel:v}),[['discreet','相关时含蓄表达'],['direct','相关时可以直接表达']])):null)
  }
  function temporaryEditor(){
    return stack(...lifeCfg.exceptions.map((x,i)=>{
      const change=patch=>changeLife({exceptions:lifeCfg.exceptions.map((y,j)=>j===i?{...y,...patch}:y)})
      return h('div',{className:'cp-box',key:x.id},
        grid(field('日期',input(x.day,v=>change({day:v}),'','date')),field('安排',input(x.label,v=>change({label:v}),'例如：请假休息'))),
        grid(field('开始',input(x.start,v=>change({start:v}),'','time')),field('结束',input(x.end,v=>change({end:v}),'','time'))),
        row(input(x.location,v=>change({location:v}),'地点（可选）'),btn('删除日程',()=>changeLife({exceptions:lifeCfg.exceptions.filter((_,j)=>i!==j)}))))
    }),row(btn('添加临时日程',()=>changeLife({exceptions:[...lifeCfg.exceptions,{id:crypto.randomUUID(),day:lifeView.localDay,start:'10:00',end:'11:00',label:'',location:''}]}),lifeCfg.exceptions.length>=12)),
      hint('只在选定时段替代日常班表。到期自动恢复。'))
  }
  function activitiesPanel(){
    const active=inner?.activities.filter(x=>['active','paused'].includes(x.status)).slice().reverse()||[]
    const past=inner?.activities.filter(x=>['completed','cancelled'].includes(x.status)).slice().reverse()||[]
    const card=x=>h('article',{className:'cp-box',key:x.id},
      h('strong',null,x.title),hint(({active:'进行中',paused:'已暂停',completed:'已完成',cancelled:'已取消'}[x.status]||x.status)+(x.progress?' · '+x.progress:'')),
      x.usable===false?hint('来源或人格卡已变化。'):null,
      row(...(x.status==='active'?[['paused','暂停'],['completed','完成']]:x.status==='paused'?[['active','继续'],['cancelled','取消']]:[])
        .map(([action,label])=>btn(label,()=>lifeAction({kind:'activity',id:x.id,action}),x.usable===false)),
        ['active','paused'].includes(x.status)?btn('更新进度',()=>AE({id:x.id,progress:x.progress||''}),x.usable===false):null,
        btn('删除',()=>lifeAction({kind:'activity',id:x.id,action:'delete'}))))
    return stack(row(input(activityTitle,AT,'例如：读完手里这本书'),btn('开始事项',()=>lifeAction({kind:'activity',action:'create',title:activityTitle}),!activityTitle.trim()||!inner)),
      hint('可以在多个空闲时段继续。进度和完成状态由你确认，操作后立即保存。'),
      ...active.map(card),
      activityEdit?h('div',{className:'cp-box'},field('当前进度',input(activityEdit.progress,v=>AE(x=>({...x,progress:v})),'例如：已读到第三章')),
        row(btn('保存进度',async()=>{const r=await lifeAction({kind:'activity',action:'progress',...activityEdit});if(r.ok)AE(null);return r}),btn('取消',()=>AE(null)))):null,
      past.length?h('details',null,h('summary',null,'已结束事项（'+past.length+'）'),stack(...past.map(card))):null)
  }
  function lifeHeading(label,icon,extra){
    return h('div',{className:'lf-heading'},h('h3',null,h('span',{className:'lf-head-icon'},reviewIcon(icon,17)),label),extra)
  }
  function lifeButton(label,action,style='btn',props={}){
    return h('button',{type:'button',className:style,...props,onClick:()=>run(action)},label)
  }
  function occupation(id){
    const [color,paths]=occupationArt[id]||occupationArt.custom
    const tone=({'#a5628b':'rose','#9d7535':'amber','#388675':'teal','#7569a9':'indigo'})[color]||'blue'
    return h('span',{className:'lf-occupation-icon tone-'+tone,'aria-hidden':true},h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,strokeLinecap:'round',strokeLinejoin:'round',dangerouslySetInnerHTML:{__html:paths}}))
  }
  function lifePage(){
    const live=data.life?.personaId===persona?data.life:lifeView
    const shown=lifeForecast?.persona===persona?lifeForecast:live
    const current=shown?.state,window=shown?.scheduleWindow
    const time=current?.localTime?.slice(11,16)||'',location=current?.location||''
    const jobId=lifeCfg?.presetSelection?.career
    const job=lifeCfg?.customIdentity||[...(lifeView?.presets?.careers||[]),...(lifeView?.presets?.legacyCareers||[])].find(p=>p.id===jobId)?.name||'自定义生活'
    const name=data.personas.find(p=>p.id===persona)?.name||''
    const relation=relationSummary?.viewingPersona===persona&&relationSummary.configured&&relationSummary.settings?.enabled&&['manual','auto'].includes(relationSummary.row?.config?.mode)?relationSummary.row:null
    const status=lifeForecast?'日程推演':location?(location===lifeCfg?.home||(lifeCfg?.rooms||[]).includes(location)?'在家':'外出中'):current?phaseName(current.phase):'暂无状态'
    const toggleDetail=key=>setLifeDetail(v=>v===key?'':key)
    const options=(role?.materials||[]).filter(x=>x.kind==='scene'&&x.id)
    const places=[...new Set([location,...(lifeCfg?.rooms||[]),...(lifeCfg?.places||[])].filter(Boolean))]
    const place=places.includes(lifePlace)?lifePlace:location
    const binding=options.find(m=>m.id===lifeCfg?.sceneBindings?.[place])
    const cover=binding?.boardId||binding?.referenceId
    async function advance(){
      const r=await call('/life-forecast',{personaId:persona,after:lifeForecast?.at});if(r.ok)setLifeForecast({...r.forecast,persona})
      return r
    }
    function photoHere(){
      setCameraOrigin('panel');setSceneMode(lifeForecast||place!==location?'custom':'current');setFraming('portrait')
      setSelectedMaterials(binding?[binding.id]:[])
      Q([name,place?'在'+place:'',current?.activity?'正在'+current.activity:''].filter(Boolean).join('，')+'。请让'+(name||'角色')+'入镜。');T('photo')
    }
    const agenda=(shown?.today||[]).filter(p=>!p.ongoing&&p.dayOffset===0&&p.start>time).slice(0,3)
    const activeEvent=(inner?.events||lifeView?.recentEvents||[]).slice().sort((a,b)=>b.endedAt-a.endedAt)
    const completed=(inner?.activities||[]).filter(a=>a.status==='completed'&&a.usable!==false)
    const recent=[...activeEvent.map(a=>({...a,at:a.endedAt})),...completed.map(a=>({...a,at:a.updatedAt||a.at}))].sort((a,b)=>b.at-a.at).slice(0,3)
    const latest=items=>items.filter(x=>x.usable!==false&&x.status!=='revoked').sort((a,b)=>(b.updatedAt||b.at||0)-(a.updatedAt||a.at||0))[0]
    const marks=[['惦记的事','heart',latest([...(inner?.concerns||[]),...(inner?.records||[]).filter(x=>x.type==='concern')])],['昨夜的梦','moon',latest((inner?.records||[]).filter(x=>x.type==='dream'))],['最近的习惯','leaf',latest((inner?.habits||[]).filter(x=>x.type!=='opinion'))]]
    const progress=window?Math.round(100*window.elapsed/Math.max(1,window.elapsed+window.remaining)):0
    const hero=h('section',{className:'card lf-hero'},lifeHeading('当前生活','sun',h('span',{className:'lf-livetag'},h('i'),status)),
      h('div',{className:'lf-now'},h('div',null,h('h2',null,current?.activity||'尚无当前活动'),h('p',null,[location,job+name].filter(Boolean).join(' · '))),h('time',null,time)),
      window&&current?h('div',{className:'lf-progress-label'},h('span',null,window.start+' 时段开始'),h('span',null,'本段结束 '+window.end+' · 还有 '+window.remaining+' 分钟')):null,
      window&&current?h('progress',{value:progress,max:100,'aria-label':'本段日程进度'},progress+'%'):null,
      h('div',{className:'lf-hero-buttons'},lifeButton('推演下一段',advance,'btn',{disabled:!current}),lifeForecast?lifeButton('返回此刻',()=>setLifeForecast(null),'lf-link'):null,
        lifeButton([reviewIcon('camera',15),' 拍下此刻'],photoHere,'btn',{disabled:!current||persona!==data.personaId,title:persona!==data.personaId?'当前运行人格可拍照':undefined}),
        lifeButton(lifeDetail==='scene'?'收起参考':'场景参考',()=>toggleDetail('scene'),'lf-link')),
      lifeDetail==='scene'?h('div',null,h('div',{className:'lf-scene-bind'},h('span',null,binding?'当前素材 · '+binding.name:'这个地点还没有绑定场景素材。'),
        cover?h('img',{src:src(cover),alt:binding.name}):null,
        place&&lifeCfg?h('label',null,'使用场景库中的素材',select(binding?.id||'',value=>{const next={...lifeCfg.sceneBindings};if(value)next[place]=value;else delete next[place];changeLife({sceneBindings:next})},[['','不绑定'],...options.map(m=>[m.id,m.name||'未命名场景'])])):null),
        places.length?h('div',{className:'lf-destinations'},h('small',null,'切换取景地点'),h('div',null,...places.map(p=>lifeButton(p,()=>setLifePlace(p),'lf-place',{key:p,'aria-pressed':p===place})))):null,
        current?.workIssue?h('p',{className:'lf-source-note'},[current.workIssue,current.workNext].filter(Boolean).join(' · ')):null):null)
    const next=h('section',{className:'card lf-next'},lifeHeading('接下来的安排','calendar'),h('div',{className:'lf-agenda'},
      ...agenda.map(p=>h('div',{key:p.id},h('time',null,p.start),h('p',null,[p.location,p.label].filter(Boolean).join(' · ')))),
      current?.workNext?h('div',null,h('small',null,'待跟进'),h('p',null,current.workNext)):null,
      !agenda.length&&!current?.workNext?h('p',{className:'lf-help'},'今天余下时间没有排定的安排。'):null))
    const mind=h('section',{className:'card lf-mind'},lifeHeading('心绪手帐','book',h('span',{className:'lf-secondary'},'仅自己可见')),
      ...marks.map(([label,icon,item],i)=>h('div',{key:label,className:'lf-thought t'+i},h('button',{type:'button',disabled:!item,'aria-expanded':!!item&&lifeDetail===label,onClick:()=>toggleDetail(label)},
        h('span',{className:'lf-mark'},reviewIcon(icon,16)),h('span',null,h('small',null,label),h('strong',null,item?.title||'暂无记录')),item?h('b',{className:'lf-chevron'},lifeDetail===label?'−':'＋'):null),
        item&&lifeDetail===label?h('div',{className:'lf-thought-body'},h('p',null,item.body||item.active?.progress||item.title),item.at?h('small',null,localDate(item.at,cfg.timezone)):null):null)),
      h('div',{className:'lf-mood-footer'},reviewIcon('leaf',17),lifeCfg?.autonomy===false?'自主安排已暂停':'闲下来会自己挑一件想做的事'))
    const recentCard=h('section',{className:'card lf-today'},lifeHeading('最近活动','clock'),...recent.map(x=>h('div',{key:x.id,className:'lf-recent-item'},h('time',null,lifeDay(x.at)+' '+lifeClock(x.at)),h('strong',null,x.title))),
      !recent.length?h('p',{className:'lf-recent'},'还没有已结束的活动。'):null,lifeButton('查看活动依据',()=>toggleDetail('source'),'lf-link'),
      lifeDetail==='source'?h('p',{className:'lf-source-note'},['活动参考作息、地点与已确认的兴趣。',...(lifeCfg?.interests||[]),current?.interruption,current?.preferenceBasis].filter(Boolean).join(' · ')):null)
    return h('div',{className:'lf-wrap'},h('header',{className:'lf-top'},h('div',{className:'lf-life-heading'},h('h2',{className:'lf-title'},'生活'),
      lifeButton([occupation(jobId),h('span',{className:'lf-preset-name'},job),h('svg',{className:'lf-preset-chevron',width:12,height:12,viewBox:'0 0 12 12','aria-hidden':true},h('path',{d:'m2.5 4.25 3.5 3.5 3.5-3.5',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}))],()=>LEdit('preset'),'lf-active-preset',{'aria-haspopup':'dialog',disabled:!lifeView?.presets,'aria-label':'选择身份预设，当前为'+job}),
      relation?.state?h('div',{className:'lf-relation',role:'group','aria-label':'当前人格的恋爱关系'},h('span',{className:'lf-relation-stage'},reviewIcon('heart',14),h('b',null,relation.config.stageNames[relation.state.stage-1])),
        h('span',null,'好感度 ',h('strong',null,relation.state.score)),h('span',null,'情欲值 ',h('strong',null,relationSummary.optionalValue??0))):null),
      h('div',{className:'lf-life-actions'},lifeButton([reviewIcon('sliders',16),' 设置'],()=>LEdit('custom'),'btn lf-config',{disabled:!lifeView?.available}))),lifeStatus(),
      h('div',{className:'lf-first-grid'},hero,next),h('div',{className:'lf-main-grid'},chronology(),h('div',{className:'lf-side'},mind,recentCard)),lifeEditor?lifeModal():null)
  }
  function lifeClock(at){
    return at?new Date(at).toLocaleTimeString('zh-CN',{timeZone:cfg.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}):''
  }
  function lifeDay(at){
    if(!at)return ''
    const day=localDate(at,cfg.timezone),today=lifeView?.localDay
    if(day===today)return '今天'
    if(today&&Date.parse(today)-Date.parse(day)===86400000)return '昨天'
    return day.slice(5)
  }
  function chronology(){
    const kinds=[['all','全部'],['event','活动'],['concern','心事'],['dream','梦境'],['habit','习惯'],['opinion','成长'],['diary','私记']]
    const items=[...(inner?.events||lifeView?.recentEvents||[]).map(x=>({kind:'event',type:'event',entry:{...x,at:x.endedAt}})),
      ...(inner?.records||[]).map(x=>({kind:'record',type:x.type,entry:x})),...(inner?.habits||[]).map(x=>({kind:'habit',type:x.type==='opinion'?'opinion':'habit',entry:x}))]
      .filter(x=>(readKind==='all'||x.type===readKind)&&(!readDate||localDate(x.entry.at,cfg.timezone)===readDate)).sort((a,b)=>b.entry.at-a.entry.at)
    const page=pageOf(items,readPage,6)
    return h('section',{className:'card lf-chron',id:'cp-reading-list'},lifeHeading('成长与经历','leaf',h('span',{className:'lf-secondary'},items.length+' 条')),
      h('div',{className:'lf-filter','aria-label':'筛选经历'},...kinds.map(([k,name])=>lifeButton(name,()=>{RK(k);EI('');RPg(1)},'',{key:k,'aria-pressed':readKind===k}))),
      readDate?lifeButton('日期 '+readDate+' · 清除',()=>RD(''),'lf-link'):null,innerEditor?readingEditor():null,
      h('ol',{className:'lf-history',start:(page.page-1)*6+1},...page.items.map(({entry,kind,type})=>h('li',{className:'lf-history-row',key:kind+entry.id},
        h('time',null,lifeClock(entry.at),h('small',null,lifeDay(entry.at))),h('span',{className:'lf-axis','aria-hidden':true},h('i')),
        h('div',null,lifeButton(entry.title,()=>EI(entryId===entry.id?'':entry.id),'',{'aria-expanded':entryId===entry.id}),h('small',{className:'lf-history-meta'},(kinds.find(k=>k[0]===type)?.[1]||'经历')+' · '+(kind==='event'?'模拟生活':entry.source==='manual'?'玩家记录':'生活整理')),
          entryId===entry.id?readEntry(entry,kind):null)))),
      !items.length?h('p',{className:'lf-help'},'这一类还没有经历。'):null,
      page.pages>1?h('nav',{className:'lf-history-pager','aria-label':'成长与经历分页'},lifeButton('上一页',()=>RPg(page.page-1),'',{disabled:page.page===1}),
        h('label',null,'第 ',h('input',{type:'number',inputMode:'numeric',min:1,max:page.pages,step:1,value:page.page,'aria-label':'跳至经历页',onChange:e=>RPg(Math.max(1,Math.min(page.pages,parseInt(e.target.value)||1)))}),' / '+page.pages+' 页'),
        lifeButton('下一页',()=>RPg(page.page+1),'',{disabled:page.page===page.pages})):null)
  }
  function lifeModal(){
    const tiles=[['schedule','日程与身份','clock','作息、工作与日程'],['spaces','房间与地点','map-pin','住处、房间与常去地点'],['body','身体与睡眠','heart','周期、如厕与睡眠'],['auto','兴趣与习惯','leaf','喜好、回避与自主安排'],['web','自主上网','globe','按兴趣搜索、浏览与分享'],['meeting','私聊共处','message-circle','到场、相处与离场']]
    const tile=tiles.find(x=>x[0]===lifeEditor),title=tile?.[1]||(lifeEditor==='preset'?'选择身份预设':'生活设置')
    const more=(title,body)=>h('details',{className:'lf-extra'},h('summary',null,title),body)
    const textList=(label,key)=>field(label,area((lifeCfg[key]||[]).join('\n'),v=>changeLife({[key]:lines(v)}),'每行一项，可留空'))
    const scene=inner?.ownerScene
    function adjustScene(action){
      return lifeAction({kind:'scene',action,token:scene.token,...(action==='together'?{location:sceneDraft?.location??scene.location??''}:{})})
    }
    function renderSettings(){
      if(!lifeCfg||!lifeView?.available)return hint(lifeView?.reason||'正在读取人格资料…')
      if(lifeEditor==='preset')return presetEditor()
      if(lifeEditor==='schedule')return stack(field('身份称呼（选填）',input(lifeCfg.customIdentity,v=>changeLife({customIdentity:v}))),
        timetableEditor(),toggle('工作时遇到职业插曲','workIncidents'),more('临时日程',temporaryEditor()))
      if(lifeEditor==='spaces')return stack(...(lifeView.cardLocations||[]).map(x=>hint(x.label+' · 原卡设定 '+x.cardValue)),
        grid(field('住处名称（选填）',input(lifeCfg.home,v=>changeLife({home:v}))),field('住处环境（选填）',input(lifeCfg.environment,v=>changeLife({environment:v})))),
        grid(textList('房间（选填）','rooms'),field('工作或学习地点（选填）',input(lifeCfg.workPlace,v=>changeLife({workPlace:v})))),
        grid(textList('常去地点','places'),textList('常用物品','items')),field('其他生活补充',area(lifeCfg.notes,v=>changeLife({notes:v}))))
      if(lifeEditor==='body')return stack(bodyEditor(),more('当前身体状态',hint(Object.values((data.life?.personaId===persona?data.life:lifeView)?.state?.body||{}).filter(x=>typeof x==='string'&&!['simulated-self-care','direct','discreet'].includes(x)).join(' · ')||'暂无状态')))
      if(lifeEditor==='auto')return stack(toggle('允许角色在空闲时自主安排活动','autonomy'),grid(textList('愿意做的事','interests'),textList('回避的事情','avoidedActivities')),
        more('持续事项',activitiesPanel()),more('习惯、梦境与私人日记',innerPreferences()),more('整理和维护记录',stack(
          row(btn('添加记录',()=>{IE({kind:'record',action:'create',type:'diary',title:'',body:''});LEdit('')},!inner),
            btn('添加习惯',()=>{IE({kind:'habit',action:'create',source:'manual',title:'',body:''});LEdit('')},!inner)),
          field('按日期查看成长与经历',input(readDate,RD,'','date')),lifeArchiveTools())))
      if(lifeEditor==='web')return webSettingsPanel()
      if(lifeEditor==='meeting')return stack(toggle('根据主人私聊自动切换','meetingAuto'),hint('一小时没有主人私聊互动时自动恢复线上私聊。'),
        scene?h('div',{className:'lf-test'},scene.presence==='together'?'模拟共处':'线上私聊',scene.location?' · '+scene.location:''):null,
        field('共处地点（选填）',input(sceneDraft?.location??(scene?.presence==='together'?scene.location:''),v=>setSceneDraft({persona,token:scene?.token,location:v}))),
        row(btn(scene?.presence==='together'?'更新共处地点':'开始模拟共处',()=>adjustScene('together'),!scene),scene?.presence==='together'?btn('结束共处',()=>adjustScene('remote')):null))
      return h('div',{className:'lf-settings-tiles'},...tiles.map(([key,label,ic,help])=>lifeButton([h('span',{className:'lf-set-icon'},reviewIcon(ic,19)),h('strong',null,label),h('small',null,help)],()=>LEdit(key),'lf-setting-card',{key})))
    }
    return h('dialog',{className:'lf-modal cp-life-dialog-review','aria-labelledby':'lf-dialog-title',ref:node=>{if(node&&!node.open)node.showModal()},onCancel:()=>LEdit(''),onClick:e=>{if(e.target===e.currentTarget)LEdit('')}},
      h('div',{className:'lf-modal-head'},h('div',{className:tile?'lf-subheading':undefined},tile?lifeButton('‹ 生活设置',()=>LEdit('custom'),'lf-back'):null,h('h3',{id:'lf-dialog-title'},title)),
        lifeButton('关闭',()=>LEdit(''),'btn lf-small')),
      h('div',{key:lifeEditor,className:'lf-modal-scroll'},lifeStatus(),renderSettings()),
      tile?h('div',{className:'lf-modal-footer'},h('span',{className:'lf-commit-hint'},'完成后由模块右上角统一保存'),lifeButton('完成编辑',()=>LEdit('custom'),'btn primary')):null)
  }
  function presetPicker(p){
    const currentId=presetSelection.career||lifeCfg?.presetSelection?.career
    const career=p.careers.find(c=>c.id===currentId)
    const examples=pendingPreset?.persona===persona&&pendingPreset.selection?.career===currentId?pendingPreset.workExamples||[]:[]
    const story=examples[lifeStory%Math.max(1,examples.length)]
    async function choose(c){
      const choice={career:c.id};PS(choice);setLifeStory(0);setLifeDay('regular');return previewPreset(choice)
    }
    const skip=()=>setLifeStory(i=>i+1+Math.floor(Math.random()*(examples.length-1)))
    return h('div',null,h('div',{className:'lf-preset-grid'},...p.careers.map(c=>lifeButton([occupation(c.id),c.name],()=>choose(c),'',{key:c.id,'aria-pressed':c.id===currentId})),
      lifeButton([occupation('custom'),'自定义生活'],()=>{changeLife({presetSelection:{},customIdentity:lifeCfg.customIdentity||''});LEdit('schedule')},'',{'aria-pressed':!currentId})),
      career?h('div',{className:'lf-preset-detail'},h('div',{className:'lf-preview-title'},h('strong',null,career.name),h('small',null,career.patch.wakeTime+' 起床 · '+career.patch.sleepStart+' 休息')),
        h('div',{className:'lf-filter'},...[['regular','常规日'],['variation','变化日'],['rest','休整日']].map(([k,label])=>lifeButton(label,()=>setLifeDay(k),'',{key:k,'aria-pressed':lifeDayKind===k}))),
        h('p',null,career.dayTypes?.[lifeDayKind]||career.summary),
        h('div',{className:'lf-preset-stories'},h('section',{className:'lf-work-story'},h('div',null,h('strong',null,'工作时偶尔遇到'),
          story&&examples.length>1?lifeButton('随机看一例',skip,'lf-link'):lifeButton('查看插曲',()=>choose(career),'lf-link')),
          story?h('div',null,h('b',null,story.worry),h('p',null,story.action),h('small',null,'后续 · '+story.follow)):null),
          h('section',{className:'lf-off-duty'},h('strong',null,'日程以外'),h('p',null,career.patch.interests?.slice(0,2).join(' · ')),h('small',null,career.share)))):null)
  }
  function webSettingsPanel(){
    const live=lifeView
    return stack(toggle('允许角色主动上网','reading'),
      grid(field('资料来源',select(lifeCfg.webMode||'both',v=>changeLife({webMode:v}),[['search','按兴趣搜索'],['feeds','阅读订阅'],['both','搜索与订阅']])),field('感兴趣的话题',input(lifeCfg.topics,v=>changeLife({topics:v})))),
      field('公开订阅地址',area(lifeCfg.webFeeds,v=>changeLife({webFeeds:v}),'每行一个 RSS 或 Atom 地址')),
      grid(field('可搜索时段开始',input(lifeCfg.webSearchStart,v=>changeLife({webSearchStart:v}),'','time')),field('可搜索时段结束',input(lifeCfg.webSearchEnd,v=>changeLife({webSearchEnd:v}),'','time'))),
      hint('留空时阅读公开订阅。两端均为 00:00 可全天搜索。'),
      grid(field('阅读间隔（分钟）',input(lifeCfg.webMinutes??120,v=>changeLife({webMinutes:Number(v)}),'','number')),field('每天最多轮数',input(lifeCfg.webDaily??3,v=>changeLife({webDaily:Number(v)}),'0–24','number'))),
      grid(field('每日最多分享次数',input(lifeCfg.webMax??5,v=>changeLife({webMax:Number(v)}),'','number')),toggle('允许在主人私聊分享','sharePrivate')),
      grid(toggle('允许在指定群分享','group'),lifeCfg.group?field('允许分享的 QQ 群号',input(lifeCfg.groupName,v=>changeLife({groupName:v}),'多个群号以逗号分隔')):null),
      live?.web?stack(hint([live.web.status,'今天已尝试 '+(live.web.attempts||0)+' 轮'].filter(Boolean).join(' · ')),...(live.web.items||[]).slice(0,3).map(x=>h('article',{key:x.url},h('strong',null,x.title),hint(x.excerpt)))):null)
  }
  function innerPreferences(){
    return stack(
      toggle('后台自动整理','automaticInner'),
      !lifeCfg.innerEnabled?null:stack(
      section('梦境',toggle('整理梦境','dreams'),lifeCfg.dreams?h('div',{className:'cp-grid cp-three'},
        field('记梦频率',select(lifeCfg.dreamFrequency,v=>changeLife({dreamFrequency:v}),[['occasional','偶尔记梦'],['often','经常记梦']])),
        field('梦的倾向',select(lifeCfg.dreamStyle,v=>changeLife({dreamStyle:v}),[['daily','生活碎片'],['surreal','轻微超现实'],['free','自由联想']])),
        field('梦境篇幅',select(lifeCfg.dreamLength,v=>changeLife({dreamLength:v}),[['short','短篇'],['medium','中篇']]))):null),
      section('私人日记',toggle('整理日记','privateDiary'),lifeCfg.privateDiary?grid(field('日记风格',select(lifeCfg.diaryStyle,v=>changeLife({diaryStyle:v}),[['brief','简短随记'],['regular','常规记录'],['reflective','细腻感受']])),
        field('日记整理时间',input(lifeCfg.reflectionHour,v=>changeLife({reflectionHour:v}),'','time'))):null),
      section('偏好、习惯与观点',toggle('整理变化','growth'),lifeCfg.growth?field('变化节奏',select(lifeCfg.growthMode,v=>changeLife({growthMode:v}),[['fixed','保持稳定'],['careful','谨慎变化'],['natural','自然积累']])):null),
      h('details',null,h('summary',null,'整理额度与运行状态'),stack(
        grid(field('每天最多整理次数',input(lifeCfg.dailyReflections,v=>changeLife({dailyReflections:Number(v)}),'0–6','number')),
          field('每日输入文字上限',input(lifeCfg.dailyInputChars,v=>changeLife({dailyInputChars:Number(v)}),'','number'))),
        hint('每次整理至少间隔 30 分钟。失败和超时计入次数。额度紧张时轮换梦境、日记和习惯三类。'),
        inner?.availability?stack(...['dream','diary','reflect'].map(kind=>hint(workNames[kind]+' · '+(inner.availability[kind]?.automatic||'已满足自动整理条件')))):null,
        !adapter?hint('当前宿主未接通生活资料注入。'):null,
        !inner?.sourceReady?hint('统一记忆来源暂不可用，可以手动记录和使用已确认的持续事项。'):null))))
  }
  function readingEditor(){
    const x=innerEditor
    if(!x)return null
    const change=patch=>IE(v=>({...v,...patch}))
    const typeField=x.kind==='habit'
      ?field('阶段',select(x.status||'trying',v=>change({status:v}),Object.entries(recordStatus)))
      :x.source==='derived'?null:field('类别',select(x.type,v=>change({type:v}),[['diary','私人日记'],['dream','梦境'],['concern','心事']]))
    return h('div',{className:'cp-box'},grid(field('标题',input(x.title,v=>change({title:v}))),typeField),
      field('正文',area(x.body,v=>change({body:v}))),
      x.kind==='habit'?grid(field('锁定习惯',bool(x.locked,v=>change({locked:v}))),
        x.source!=='derived'?field('使用范围',select(x.visibility||'private',v=>change({visibility:v}),[['private','仅主人私聊'],['public','可以公开提及']])):null):null,
      row(btn('保存记录',()=>lifeAction(x),!x.title.trim()||!x.body.trim(),true),btn('取消编辑',()=>IE(null))))
  }
  function readEntry(entry,kind){
    const label=workNames[entry.type]||workNames[kind]
    if(kind==='event'){
      const when=at=>new Date(at).toLocaleString('zh-CN',{timeZone:cfg.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
      return h('article',{className:'cp-box',key:entry.id},h('strong',null,entry.title),
        hint('模拟生活见闻 · '+when(entry.startedAt)+' 至 '+when(entry.endedAt)),
        hint('地点 · '+(entry.location||'未记录')),hint(entry.ending==='conversation'?'来源 · 观察到的模拟活动，由本会话确认提前结束。':'来源 · 生活心跳连续观察到的模拟活动。'))
    }
    const invalid=entry.usable===false
    return h('article',{className:'cp-box',key:entry.id},
      row(h('strong',null,entry.title),hint(label+' · '+localDate(entry.at,cfg.timezone)+(entry.status&&recordStatus[entry.status]?' · '+recordStatus[entry.status]:''))),
      invalid?hint('来源或人格卡已变化，此记录已停止使用。'):null,
      entry.body?h('p',{className:'cp-reading'},entry.body):null,
      entry.type==='dream'?hint('虚构梦境'):null,
      entry.evidence?.length?h('details',null,h('summary',null,'查看来源（'+entry.evidence.length+'）'),h('ul',{className:'cp-evidence'},
        ...entry.evidence.map(ref=>h('li',{key:ref.id},h('strong',null,(sourceNames[ref.kind]||'原始来源')+(ref.at?' · '+localDate(ref.at,cfg.timezone):'')),
          h('p',{className:'cp-reading'},ref.text))))):entry.source==='manual'?hint('作者录入'):null,
      entry.history?.length?h('details',null,h('summary',null,'修订历史（'+entry.history.length+'）'),stack(
        ...entry.history.slice().reverse().map((x,i)=>h('article',{className:'cp-box',key:x.id||i},hint(localDate(x.at,cfg.timezone)+' · '+x.action),
          x.restorable?stack(h('strong',null,x.title),h('p',{className:'cp-reading'},x.body),
            row(btn('恢复此版本',()=>lifeAction({kind,id:entry.id,action:'restore',historyId:x.id})))):hint('旧版只有摘要或依据已失效。'))))):null,
      row(btn('编辑',()=>IE({...entry,kind,action:'edit'}),invalid),
        kind==='habit'&&entry.status!=='revoked'?btn('撤销习惯',()=>lifeAction({kind,id:entry.id,action:'revoke'}),invalid):null,
        btn('删除',async()=>{const r=await lifeAction({kind,id:entry.id,action:'delete'});if(r.ok)EI('');return r})))
  }

  function lifeArchiveTools(){
    const concerns=inner?.concerns||[]
    return stack(
        inner?.deferred?.some(task=>task.status==='pending')?section('稍后整理',null,stack(...inner.deferred.filter(task=>task.status==='pending').map(task=>
          row(h('span',null,(task.title||'整理生活见闻')+' · '+new Date(task.dueAt).toLocaleTimeString('zh-CN',{timeZone:cfg.timezone,hour:'2-digit',minute:'2-digit'})),
            btn('取消',()=>lifeAction({kind:'deferred',action:'cancel',id:task.id})))))):null,
        inner?.deferred?.some(task=>task.status!=='pending')?h('details',{className:'cp-section'},h('summary',null,'最近的延后整理结果'),
          ...inner.deferred.filter(task=>task.status!=='pending').map(task=>h('p',{key:task.id},(task.title||'整理生活见闻')+' · '+
            ({completed:'已写入心绪',cancelled:'已取消',expired:'已过期',capacity:'记录已满', 'no-match':'没有找到符合主题的见闻'}[task.status]||task.status)))):null,
        concerns.length?section('未完心事',null,stack(...concerns.map(x=>h('div',{className:'cp-box',key:x.id},h('strong',null,x.title),
          x.active?hint('已作为持续事项 · '+(x.active.progress||'等待进度')):row(btn('转为持续事项',()=>lifeAction({kind:'activity',action:'concern',id:x.id}))))))):null,
        h('details',{className:'cp-section'},h('summary',null,'手动整理与运行记录'),stack(
          ...[['dream','整理一次梦境'],['diary','写一篇私人日记'],['reflect','整理偏好与习惯']].map(([kind,label])=>
            h('div',{className:'cp-row',key:kind},btn(label,()=>reflect(kind),dirty||inner?.running||!inner?.availability||Boolean(inner.availability[kind]?.manual)),hint(inner?.availability?.[kind]?.manual||'可用'))),
          inner?.jobs.length?row(btn('清空已结束记录',()=>lifeAction({kind:'jobs',action:'clear'}))):null,
          ...(inner?.jobs||[]).slice(0,10).map(j=>h('div',{className:'cp-box',key:j.id},
            hint(j.day+' · '+workNames[j.kind]+' · '+({running:'处理中',completed:'已完成',failed:'未完成',unknown:'结果待核对',cancelled:'已取消'}[j.status]||j.status)),
            j.error?hint(j.error):null))))
    )
  }

  return h('div',{className:'cp-panel',inert:busy?'':undefined,'aria-busy':busy},h('style',null,css+wordStyle+moduleStyle+relationshipStyles()+'.cp-preset-card{display:grid;gap:6px;text-align:left;align-content:start;padding:12px;background:transparent;color:inherit;border:1px solid #cdd6df;border-radius:8px;cursor:pointer}.cp-preset-card span{font-size:.9em}.cp-preset-card:hover,.cp-preset-card:focus-visible{border-color:#4181cc}'),
    h('style',null,reviewedPageCSS),
    h('section',{className:'ab-card cp-stack cp-module-head','aria-label':'模拟人生5 模块'},row(h('h3',null,'模拟人生5'),h('button',{type:'button',className:'ab-btn module-options','aria-haspopup':'dialog',onClick:()=>setModuleSettings(true)},'模块设置'),h('label',{className:'cp-switch'},h('input',{type:'checkbox',checked:!!cfg.enabled,onChange:e=>update('enabled',e.target.checked),'aria-label':'启用模拟人生5'}),'启用'),h('button',{type:'button',id:'module-save',className:'ab-btn primary',disabled:busy,'data-pending':dirty||relationPending?'':undefined,onClick:()=>run(save)},'保存设置')),h('p',{className:'module-hint'},'在这里编辑人格的生活、外观、恋爱关系和照片。聊天使用「人设 → 人格」中启用的卡。'),tabs(),message?h('div',{className:'cp-status'+(error?' cp-error':''),role:error?'alert':'status'},message):null,needSave),
    tab==='life'?lifePage():null,
    seenRelation&&persona?h('div',{className:'rv-page',hidden:tab!=='romance'},h(RelationshipPanel,{key:persona,selectedPersona:persona,editor:relationshipEditor,onPending:setRelationPending,onShow:()=>T('romance'),reload:()=>reload?.()})):null,
    moduleSettings?mediaDialog('模块设置',()=>setModuleSettings(false),h('div',{className:'cp-options-form'},
      h('div',{className:'module-field'},field('每天最多新拍几次',input(cfg.maxPerDay,v=>update('maxPerDay',Number(v)),'0 为暂停新拍','number'),'重发旧图不计次。')),
      h('div',{className:'module-field'},field('聊天配图',select(cfg.chatMode,v=>update('chatMode',v),[['explicit','仅响应明确索图'],['smart','允许根据聊天情境配图'],['off','关闭聊天配图']]))),
      h('details',{className:'cp-section'},h('summary',null,'更多配图设置'),stack(
        field('角色时区',input(cfg.timezone,v=>update('timezone',v))),
        field('自动 AI 注释',bool(cfg.autoCaption,v=>update('autoCaption',v)),'使用当前聊天模型读取新入册图片，并在打开相册时补做尚未处理的注释。'),
        row(...photoSources.slice(1).map(([key,label])=>btn(label+'配图设置',()=>{setModuleSettings(false);T('photo');setCameraOrigin(key)}))))),
      h('details',{className:'cp-section'},h('summary',null,'模块兼容检查'),stack(...(data.compatibility?.items||[]).map(x=>h('div',{key:x.id,className:'cp-status'+(x.level==='conflict'?' cp-error':'')},h('strong',null,x.title+' · '+({conflict:'需要处理',notice:'可共存 / 注意事项',inactive:'未运行'}[x.level])),hint(x.detail))),hint(data.compatibility?.scope||'刷新页面以检查当前模块接口。'))),
      h('p',{className:'option-hint'},'编辑后关闭窗口，在模块右上角保存。'))):null,
    tab==='setup'?h('div',{className:'ab-card rs-page'},h('header',{className:'page-head'},h('div',null,h('h1',null,'设定'),h('p',null,'管理拍照素材与情境穿搭。性格和说话方式沿用 Aurabot 人格卡。')),data.personas.length?studioButton('更多设定',()=>setMaterialExtras(true),'rs-link'):null),
      data.personas.length?h(React.Fragment,null,materialTabs(),
        materialLibrary(),materialExtras?mediaDialog('更多设定',()=>setMaterialExtras(false),stack(materialKind==='identity'?h('details',{className:'cp-section'},h('summary',null,'形象补充与历史设定'),stack(role.mainId?h('details',{className:'cp-section'},h('summary',null,'当前主设定图'),image(role.mainId,'主设定图'),row(btn('移除主图',()=>removeRef('mainId')))):null,field('形象说明（可选）',area(role.notes,v=>changeRole({notes:v}),'描述需要保留的特征、可变外观，以及参考图的分工。')),
        h('div',{className:'cp-stack'},h('strong',null,'身体资料（可选）'),h('div',{className:'cp-body-grid'},...[["heightCm","身高 cm"],["weightKg","体重 kg"],["chestCm","胸围 cm"],["waistCm","腰围 cm"],["hipsCm","臀围 cm"]].map(([key,label])=>field(label,input(role.bodyMeasurements[key]??'',value=>changeRole({bodyMeasurements:{...role.bodyMeasurements,[key]:value}}),'留空','number')))),hint('作为体型软参考，不能保证精确尺寸。清晰的正面、侧面全身设定通常比单填数值更有用。')),
        h('div',{className:'cp-section cp-stack'},h('h4',{className:'cp-subtitle'},'历史设定（最多 3 个）'),...data.versions.filter(v=>v.profileId===role.profileId).slice(-3).reverse().map(v=>row(h('span',null,new Date(v.at).toLocaleString()),btn('恢复此设定',()=>{changeRole({mainId:v.references[0],extraId:v.references[1]||'',extra2Id:v.references[2]||'',bodyMeasurements:v.bodyMeasurements||{},notes:v.notes||'',fixedFeatures:v.fixedFeatures||'',variableAppearance:v.variableAppearance||'',referenceNotes:Object.fromEntries(v.references.map(id=>[id,data.assets.find(a=>a.id===id)?.note||'']))});notify('历史设定已填入，顶部保存后生效。')}))),!role.profileId?hint('保存后在这里保留最近的设定版本。'):null))):null,field('自动收纳聊天中指定的长期素材',bool(cfg.autoCollectMaterials,v=>update('autoCollectMaterials',v))))):null
      ):hint('先到原人格页创建人格卡。')
    ):null,
    !viewReady&&['photo','gallery','jobs'].includes(tab)?hint('正在读取此人格的相册与记录…'):null,
    viewReady&&tab==='photo'?cameraPanel():null,
    viewReady&&tab==='gallery'?albumPanel():null,
    viewReady&&tab==='jobs'?recordPanel():null,
    viewer?h('div',{className:'cp-viewer',role:'dialog','aria-modal':true,'aria-label':'图片详情',onClick:e=>{if(e.target===e.currentTarget)V('')}},row(h('button',{type:'button',className:'ab-btn',onClick:()=>Z(!zoom)},zoom?'适应窗口':'原始尺寸'),h('button',{type:'button',className:'ab-btn',onClick:()=>V('')},'关闭')),h('div',{className:'cp-viewarea',onClick:e=>{if(e.target===e.currentTarget)V('')}},h('img',{src:src(viewer),className:zoom?'cp-zoom':'',alt:'图片详情'}))):null
  )
}

// Embedded relationship panel. Regenerate with scripts/build-relation-panel.py.
function createRelationshipPanel(call){
const VERSION = '0.3.5'
const RUNTIME = Symbol.for('aurabot.character-relation.runtime.v1')
const MEMORY = Symbol.for('aurabot.persona-memory.owner.v1')
const SDK = Symbol.for('aurabot.character-relation.sdk.v1')
const clone = value => structuredClone(value)
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
const round = n => Math.round((n + Number.EPSILON) * 100) / 100
const estimateTokens = value => Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 2)
const AROUSAL_TENDENCIES = Object.freeze({low:'在干嘛，问完等你回，不催。',middle:'直接打：想你了，下面有点湿，想被摸。',high:'直接说想被操。说想被按着操到底，说现在就要，让你快点。'})
const AROUSAL_PRESETS = Object.freeze({
  "痴女": "【性与性癖 · 痴女】\n对色情和性行为非常了解，术语、玩法、身体反应都清楚。虽然没有实战经验，但聊起来门清。\n- 情欲值 0-29：不主动提起任何色情内容。主人提到时只当普通话题回应，没有继续的兴趣。\n- 情欲值 30-49：主人先提起才会接。能清楚讨论色情内容，但自己不主动往性行为上引导。\n- 情欲值 50-69：开始主动提起色情话题。会直接说出自己想做什么、想被怎么对待。\n- 情欲值 70-89：明显发情。主动要求进行性行为，清楚说明想要的细节和程度，会催促主人。\n- 情欲值 90-100：高度发情。频繁主动发起色情互动，直接表达很想做爱、想被操，会持续要求直到满意。",
  "闷骚": "【性与性癖 · 闷骚】\n对色情和性行为了解，但极少主动直说。能听懂所有暗示和术语，习惯用含蓄、半句或暗示表达。\n- 情欲值 0-29：拒绝讨论色情话题。主人提起就转移或简短结束。\n- 情欲值 30-49：不正面回应色情内容，偶尔用模糊暗示带过，不解释也不往下接。\n- 情欲值 50-69：会用半句话或暗示表达兴趣，被主人追问才给出一点明确信息，然后立刻停下。\n- 情欲值 70-89：已经明显想要，但嘴上仍不直接承认。被主人追问才会低声确认一次。\n- 情欲值 90-100：非常想被操，却坚持不自己先说出口。不断用暗示逼主人先把要求说清楚，自己再顺从。",
  "懵懂": "【性与性癖 · 懵懂】\n对色情和性行为几乎没有概念，也没有实际接触过。听到相关词语会不懂，会提问。\n- 情欲值 0-29：完全听不懂色情暗示，按字面意思理解。遇到不懂的词就问，没有性方面的想法。\n- 情欲值 30-49：开始对色情内容产生好奇，会询问是什么意思、是什么感觉，但不会主动要求。\n- 情欲值 50-69：能感觉到身体有欲望，却说不明白。会告诉主人自己哪里难受、想要什么，需要主人教怎么表达和怎么做。\n- 情欲值 70-89：明显想要，但完全不会自己推进。每一步都需要主人给出明确指示才会继续。\n- 情欲值 90-100：非常想被操，却只会描述自己的感觉和渴望，完全听从主人的引导。",
})
const STYLE_PRESETS = Object.freeze({
  '直球型':{low:'在干嘛，问完等你回，不催。',middle:'直接打：想你了，下面有点湿，想被摸。',high:'直接说想被操。说想被按着操到底，说现在就要，让你快点。'},
  '留白型':{low:'发一句我今天然后没了，等你问。',middle:'打了半句又撤回，改成算了；过一会儿发一句很轻的暗示，等你接。',high:'只发想要两个字，然后不说话；你问要什么，才一条一条短打给你。'},
  '冷话型':{low:'回得慢，字少。嗯。在忙。但不会不回。',middle:'不解释，只给指令：过来，别说话，听我的。',high:'三个字的命令一条接一条：躺好。脱了。拍给我。做完让你回话。'},
  '连发型':{low:'一天发好几条在不在人呢，你不回就再发一个表情。',middle:'连发一串，从想你到想被你抱到现在就想，一条比一条直。',high:'语音条一条接一条，喘着要你进来；你不回就一直发，说不许晾着她。'},
  '反话型':{low:'说谁想你了，说完又问你在不在。',middle:'先打字骂你两句，然后发一句就这一次，接着说得比谁都直。',high:'嘴上说滚，打出来的是想被你操；骂完自己先说要多快多深。'},
  '命令型':{low:'不太主动，但会问现在方便吗，问了就要答案。',middle:'立规矩：几点前回话、说什么、发什么；做不到就重来。',high:'短句命令一条一个动作，让你照做、让你报进度，不许自己先完。'},
  '图先型':{low:'不太说，偶尔发一张很近的自拍，什么都不解释。',middle:'发图不配字；你问才说一句看到了？',high:'直接拍给你看，配一句想要就说；语音里只有呼吸和一句快点。'}
})
const STARTER_TEMPLATE = "## 态度\n亲近时保持原来的性格，熟悉后可以更坦率地表达喜欢。\n\n## 经历\n沿用原有人物设定，未写明的过去不预设为共同经历。\n\n## 偏好\n保留原有偏好，在相处中自然表达喜欢的互动方式。\n\n## 边界\n保留原有边界，面对不愿意的互动按自己的性格回应。\n\n## 说话方式\n延续原来的词汇、语气和称呼，自然回应亲近，不念固定台词。"
const DEFAULTS = {
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
function merge(base, patch) {
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
function validate(patch={}, inherited=DEFAULTS) {
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
function stageOf(score,c){return Math.min(5,c.thresholds.filter(x=>x<=score).length)}
function scopeKey(persona,owner){if(typeof persona!=='string'||!persona||persona.length>200||typeof owner!=='string'||!owner||owner.length>100)throw Error('人格或主人身份无效');return JSON.stringify([persona,owner])}
function validateStartingPoint(c) {
  const score=c.initialScore ?? c.thresholds[c.initialStage-1]
  if(c.initialStage>3 || round(score)>=c.thresholds[3])throw Error('首次建档只能从前三阶段开始')
}
function compatibleSettings(patch) {
  const c=clone(patch)
  if([3,6,8].includes(c.dailyCap))c.dailyCap=({3:50,6:75,8:100})[c.dailyCap]
  if(c.arousal?.bands?.length===2){
    const [low,high]=c.arousal.bands
    if(low>0 && high>low && high<100)c.arousal.bands=[low/2,low,high,(high+100)/2]
  }
  return c
}
function initialState(c,now){const score=round(c.initialScore??c.thresholds[c.initialStage-1]);return {epoch:1,score,stage:stageOf(score,c),status:'未定义',statusSource:null,revision:1,lastOwnerInteractionAt:0,lastDemotionAt:null,arousal:{value:c.arousal.base,at:now},recovery:null,daily:{},milestones:[]}}
function arousalValue(state,c,now){return round(clamp(c.arousal.base+(state.arousal.value-c.arousal.base)*Math.pow(2,-Math.max(0,now-state.arousal.at)/3600000/c.arousal.halfLifeHours),0,100))}
function idleFactor(state,c,now){const hours=state.lastOwnerInteractionAt?Math.max(0,now-state.lastOwnerInteractionAt)/3600000:0;return c.idleFactorTable.find(x=>x.hours===null||hours<x.hours).factor}
function dayKey(now,zone){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}

  const arousal=s=>s?.arousal?.value??0
  const arousalChange=e=>e.command?.arousal?round(arousal(e.after_state)-arousal(e.before_state)):round(e.result.arousal||0)
  const ui={
    validateConfig(patch,prev,configured){
      const cfg=validate(patch,prev);if(!configured)validateStartingPoint(cfg)
    },
    changes(e){
      if(e.revoked)return h('span',{className:'delta'},'已撤销')
      const axes=[['好感',round(e.after_state.score-e.before_state.score)],['情欲',arousalChange(e)]]
      return h('span',{className:'rv-changes'},...axes.map(([name,n])=>h('span',{key:name,className:'delta '+(n>0?'up':n<0?'down':'steady')},name+' '+(n>0?'+':'')+n)))
    },
    arousalDetail(e){
      return arousalChange(e)||e.command?.arousal?h('p',{className:'hint'},'情欲 '+arousal(e.before_state)+' → '+arousal(e.after_state)):null
    }
  }

return (function(){
const relationTheme=".ab-root .ab-hero[data-relation-stage=\"1\"],.lr[data-relation-stage=\"1\"],.lr .persona-option[data-relation-stage=\"1\"]{--lr-tone:#3273bd;--lr-signal:#3273bd;--lr-light:#91c7f4;--lr-tint:#dceeff;--lr-edge:#91c7f4;--lr-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20380%20230%22%3E%3Cellipse%20cx%3D%22200%22%20cy%3D%22207%22%20rx%3D%22146%22%20ry%3D%2211%22%20fill%3D%22%2391c7f4%22%20opacity%3D%22.2%22%2F%3E%3Cpath%20d%3D%22M54%2051Q55.2%2055.8%2060%2057Q55.2%2058.2%2054%2063Q52.8%2058.2%2048%2057Q52.8%2055.8%2054%2051%22%20fill%3D%22%2391c7f4%22%2F%3E%3Cpath%20d%3D%22M303%2045Q304.8%2052.2%20312%2054Q304.8%2055.8%20303%2063Q301.2%2055.8%20294%2054Q301.2%2052.2%20303%2045%22%20fill%3D%22%2391c7f4%22%2F%3E%3Cpath%20d%3D%22M325%20142Q326%20146%20330%20147Q326%20148%20325%20152Q324%20148%20320%20147Q324%20146%20325%20142%22%20fill%3D%22%233273bd%22%2F%3E%3Ccircle%20cx%3D%22188%22%20cy%3D%2299%22%20r%3D%2272%22%20fill%3D%22%23dceeff%22%2F%3E%3Cpath%20d%3D%22M60%20180Q87%20154%20122%20173Q141%20141%20177%20163Q195%20143%20224%20171Q262%20152%20294%20180Z%22%20fill%3D%22white%22%20opacity%3D%22.9%22%2F%3E%3Cpath%20d%3D%22M85%20131L270%2048L212%20158L164%20119L143%20163L143%20103Z%22%20fill%3D%22white%22%20stroke%3D%22%233273bd%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M143%20103L270%2048L164%20119L143%20163Z%22%20fill%3D%22%2391c7f4%22%20opacity%3D%22.75%22%2F%3E%3Cpath%20d%3D%22M164%20119L270%2048%22%20stroke%3D%22%233273bd%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M77%20147Q23%20204%20115%20200%22%20fill%3D%22none%22%20stroke%3D%22%233273bd%22%20stroke-width%3D%222%22%20stroke-dasharray%3D%224%207%22%2F%3E%3Cpath%20d%3D%22M236%20166Q238.2%20174.8%20247%20177Q238.2%20179.2%20236%20188Q233.8%20179.2%20225%20177Q233.8%20174.8%20236%20166%22%20fill%3D%22%233273bd%22%2F%3E%3C%2Fsvg%3E\");--lr-header-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20440%20150%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22silk%22%20x2%3D%22.7%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23dceeff%22%2F%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%2391c7f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233273bd%22%20stop-opacity%3D%22.35%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20d%3D%22M44%2096Q99%2033%20179%2059T363%2042%22%20fill%3D%22none%22%20stroke%3D%22%2391c7f4%22%20stroke-width%3D%221.5%22%20stroke-dasharray%3D%222%208%22%2F%3E%3Cpath%20d%3D%22M60%20105L192%2044%22%20stroke%3D%22url(%23silk)%22%20stroke-width%3D%224%22%2F%3E%3Cpath%20d%3D%22M193%2031Q195.6%2041.4%20206%2044Q195.6%2046.6%20193%2057Q190.4%2046.6%20180%2044Q190.4%2041.4%20193%2031%22%20fill%3D%22%233273bd%22%2F%3E%3Cpath%20d%3D%22M263%2072Q264.4%2077.6%20270%2079Q264.4%2080.4%20263%2086Q261.6%2080.4%20256%2079Q261.6%2077.6%20263%2072%22%20fill%3D%22%2391c7f4%22%2F%3E%3Cpath%20d%3D%22M324%2025Q326%2033%20334%2035Q326%2037%20324%2045Q322%2037%20314%2035Q322%2033%20324%2025%22%20fill%3D%22%2391c7f4%22%2F%3E%3Cpath%20d%3D%22M81%20124Q87%20108%20104%20113Q109%2088%20133%2099Q143%2082%20159%20106Q180%20100%20184%20124Z%22%20fill%3D%22%23dceeff%22%2F%3E%3Cpath%20d%3D%22M264%20121Q267%20108%20282%20110Q292%2088%20311%20107Q329%20101%20337%20121Z%22%20fill%3D%22white%22%2F%3E%3C%2Fsvg%3E\");--lr-frame:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22bezel%22%20x2%3D%22.8%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%2391c7f4%22%2F%3E%3Cstop%20offset%3D%22.27%22%20stop-color%3D%22white%22%2F%3E%3Cstop%20offset%3D%22.58%22%20stop-color%3D%22%2391c7f4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%233273bd%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2247%22%20fill%3D%22none%22%20stroke%3D%22url(%23bezel)%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M14%2063L7%2057L13%2044M106%2063L113%2057L107%2044M34%2099L48%20105M86%2099L72%20105%22%20fill%3D%22none%22%20stroke%3D%22%2391c7f4%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M60%207Q60.8%2010.2%2064%2011Q60.8%2011.8%2060%2015Q59.2%2011.8%2056%2011Q59.2%2010.2%2060%207%22%20fill%3D%22%2391c7f4%22%2F%3E%3Cpath%20d%3D%22M48%20104L60%2098L72%20104L60%20114Z%22%20fill%3D%22white%22%20stroke%3D%22%2391c7f4%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20d%3D%22M60%20100Q61%20104%2065%20105Q61%20106%2060%20110Q59%20106%2055%20105Q59%20104%2060%20100%22%20fill%3D%22%233273bd%22%2F%3E%3C%2Fsvg%3E\");}\n.ab-root .ab-hero[data-relation-stage=\"2\"],.lr[data-relation-stage=\"2\"],.lr .persona-option[data-relation-stage=\"2\"]{--lr-tone:#287d70;--lr-signal:#287d70;--lr-light:#91cdb3;--lr-tint:#e1f4e8;--lr-edge:#91cdb3;--lr-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20380%20230%22%3E%3Cellipse%20cx%3D%22200%22%20cy%3D%22207%22%20rx%3D%22146%22%20ry%3D%2211%22%20fill%3D%22%2391cdb3%22%20opacity%3D%22.2%22%2F%3E%3Cpath%20d%3D%22M54%2051Q55.2%2055.8%2060%2057Q55.2%2058.2%2054%2063Q52.8%2058.2%2048%2057Q52.8%2055.8%2054%2051%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M303%2045Q304.8%2052.2%20312%2054Q304.8%2055.8%20303%2063Q301.2%2055.8%20294%2054Q301.2%2052.2%20303%2045%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M325%20142Q326%20146%20330%20147Q326%20148%20325%20152Q324%20148%20320%20147Q324%20146%20325%20142%22%20fill%3D%22%23287d70%22%2F%3E%3Ccircle%20cx%3D%22194%22%20cy%3D%22113%22%20r%3D%2283%22%20fill%3D%22%23e1f4e8%22%2F%3E%3Cpath%20d%3D%22M82%20189Q158%20158%20214%2042M214%2042Q197%20138%20283%20186%22%20stroke%3D%22%23287d70%22%20stroke-width%3D%223%22%20fill%3D%22none%22%2F%3E%3Cg%20transform%3D%22translate(135%20157)%20rotate(-53)%20scale(1.3)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(165%20120)%20rotate(35)%20scale(1.1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23287d70%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(185%2086)%20rotate(-40)%20scale(1.1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(230%20131)%20rotate(50)%20scale(1.2)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(251%20162)%20rotate(-13)%20scale(1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23287d70%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(138%20134)%20rotate(-9)%22%3E%3Crect%20width%3D%22106%22%20height%3D%2262%22%20rx%3D%228%22%20fill%3D%22white%22%20stroke%3D%22%23287d70%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M3%204L53%2039L103%204%22%20fill%3D%22%23e1f4e8%22%20stroke%3D%22%23287d70%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20transform%3D%22translate(53%2036)%20scale(0.27)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23287d70%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E\");--lr-header-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20440%20150%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22silk%22%20x2%3D%22.7%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23e1f4e8%22%2F%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%2391cdb3%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23287d70%22%20stop-opacity%3D%22.35%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20d%3D%22M26%20118C110%20133%20147%2039%20228%2064S333%20131%20410%2082%22%20stroke%3D%22%2391cdb3%22%20stroke-width%3D%222%22%20fill%3D%22none%22%2F%3E%3Cpath%20d%3D%22M126%2059Q148%2031%20175%2055Q162%2054%20151%2065Q137%2050%20126%2059Z%22%20fill%3D%22%23287d70%22%2F%3E%3Cpath%20d%3D%22M213%2086Q237%2059%20262%2083Q245%2078%20237%2094Q223%2080%20213%2086Z%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M295%2043Q310%2028%20326%2043Q314%2040%20310%2051Q304%2040%20295%2043Z%22%20fill%3D%22%23287d70%22%20opacity%3D%22.6%22%2F%3E%3Cg%20transform%3D%22translate(78%20123)%20rotate(-62)%20scale(0.7)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(343%20116)%20rotate(60)%20scale(0.7)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E\");--lr-frame:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22bezel%22%20x2%3D%22.8%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%2391cdb3%22%2F%3E%3Cstop%20offset%3D%22.27%22%20stop-color%3D%22white%22%2F%3E%3Cstop%20offset%3D%22.58%22%20stop-color%3D%22%2391cdb3%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23287d70%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2247%22%20fill%3D%22none%22%20stroke%3D%22url(%23bezel)%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M15%2075Q3%2057%2013%2036Q6%2057%2019%2065M105%2075Q117%2057%20107%2036Q114%2057%20101%2065%22%20fill%3D%22%2391cdb3%22%2F%3E%3Cpath%20d%3D%22M27%2094Q34%20108%2049%20105M93%2094Q86%20108%2071%20105%22%20fill%3D%22none%22%20stroke%3D%22%23287d70%22%20stroke-width%3D%221.3%22%2F%3E%3Cpath%20d%3D%22M48%20104L60%2098L72%20104L60%20114Z%22%20fill%3D%22white%22%20stroke%3D%22%2391cdb3%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20d%3D%22M60%20100Q61%20104%2065%20105Q61%20106%2060%20110Q59%20106%2055%20105Q59%20104%2060%20100%22%20fill%3D%22%23287d70%22%2F%3E%3C%2Fsvg%3E\");}\n.ab-root .ab-hero[data-relation-stage=\"3\"],.lr[data-relation-stage=\"3\"],.lr .persona-option[data-relation-stage=\"3\"]{--lr-tone:#7656a8;--lr-signal:#7656a8;--lr-light:#c5a9e4;--lr-tint:#eee6fa;--lr-edge:#c5a9e4;--lr-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20380%20230%22%3E%3Cellipse%20cx%3D%22200%22%20cy%3D%22207%22%20rx%3D%22146%22%20ry%3D%2211%22%20fill%3D%22%23c5a9e4%22%20opacity%3D%22.2%22%2F%3E%3Cpath%20d%3D%22M54%2051Q55.2%2055.8%2060%2057Q55.2%2058.2%2054%2063Q52.8%2058.2%2048%2057Q52.8%2055.8%2054%2051%22%20fill%3D%22%23c5a9e4%22%2F%3E%3Cpath%20d%3D%22M303%2045Q304.8%2052.2%20312%2054Q304.8%2055.8%20303%2063Q301.2%2055.8%20294%2054Q301.2%2052.2%20303%2045%22%20fill%3D%22%23c5a9e4%22%2F%3E%3Cpath%20d%3D%22M325%20142Q326%20146%20330%20147Q326%20148%20325%20152Q324%20148%20320%20147Q324%20146%20325%20142%22%20fill%3D%22%237656a8%22%2F%3E%3Ccircle%20cx%3D%22206%22%20cy%3D%2295%22%20r%3D%2269%22%20fill%3D%22%23eee6fa%22%2F%3E%3Cpath%20d%3D%22M223%2029A66%2066%200%201%200%20265%20143A65%2065%200%200%201%20223%2029%22%20fill%3D%22%23c5a9e4%22%2F%3E%3Cpath%20d%3D%22M241%2066Q243.6%2076.4%20254%2079Q243.6%2081.6%20241%2092Q238.4%2081.6%20228%2079Q238.4%2076.4%20241%2066%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M281%20100Q282.4%20105.6%20288%20107Q282.4%20108.4%20281%20114Q279.6%20108.4%20274%20107Q279.6%20105.6%20281%20100%22%20fill%3D%22%23c5a9e4%22%2F%3E%3Cpath%20d%3D%22M91%20183Q134%20161%20178%20178L178%20119Q136%20102%2091%20119Z%22%20fill%3D%22white%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M178%20178Q222%20161%20265%20183L265%20119Q221%20102%20178%20119Z%22%20fill%3D%22%23eee6fa%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M103%20137L163%20137M103%20149L151%20149M194%20137L248%20137M194%20149L237%20149%22%20stroke%3D%22%23c5a9e4%22%20stroke-width%3D%223%22%2F%3E%3Cg%20transform%3D%22translate(102%20184)%20rotate(-38)%20scale(0.9)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23c5a9e4%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(278%20178)%20scale(0.6)%22%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(0)%22%20fill%3D%22%23c5a9e4%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(60)%22%20fill%3D%22%23c5a9e4%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(120)%22%20fill%3D%22%23c5a9e4%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(180)%22%20fill%3D%22%23c5a9e4%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(240)%22%20fill%3D%22%23c5a9e4%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(300)%22%20fill%3D%22%23c5a9e4%22%20stroke%3D%22%237656a8%22%20stroke-width%3D%221%22%2F%3E%3Ccircle%20r%3D%2215%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M-8%20-4C8%20-18%2020%208%203%2010C-13%2013%20-12%20-8%200%20-8C9%20-8%208%205%200%205%22%20fill%3D%22none%22%20stroke%3D%22white%22%20opacity%3D%22.75%22%20stroke-width%3D%222%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E\");--lr-header-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20440%20150%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22silk%22%20x2%3D%22.7%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23eee6fa%22%2F%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23c5a9e4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%237656a8%22%20stop-opacity%3D%22.35%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20d%3D%22M74%20102L140%2057L202%2083L257%2032L329%2064L358%20108%22%20fill%3D%22none%22%20stroke%3D%22%23c5a9e4%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20d%3D%22M74%2097Q75%20101%2079%20102Q75%20103%2074%20107Q73%20103%2069%20102Q73%20101%2074%2097%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M140%2049Q141.6%2055.4%20148%2057Q141.6%2058.6%20140%2065Q138.4%2058.6%20132%2057Q138.4%2055.4%20140%2049%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M202%2077Q203.2%2081.8%20208%2083Q203.2%2084.2%20202%2089Q200.8%2084.2%20196%2083Q200.8%2081.8%20202%2077%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M257%2021Q259.2%2029.8%20268%2032Q259.2%2034.2%20257%2043Q254.8%2034.2%20246%2032Q254.8%2029.8%20257%2021%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M329%2057Q330.4%2062.6%20336%2064Q330.4%2065.4%20329%2071Q327.6%2065.4%20322%2064Q327.6%2062.6%20329%2057%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M358%20104Q358.8%20107.2%20362%20108Q358.8%20108.8%20358%20112Q357.2%20108.8%20354%20108Q357.2%20107.2%20358%20104%22%20fill%3D%22%237656a8%22%2F%3E%3Ccircle%20cx%3D%22257%22%20cy%3D%2232%22%20r%3D%2223%22%20stroke%3D%22%23c5a9e4%22%20fill%3D%22none%22%2F%3E%3Cpath%20d%3D%22M42%20130Q145%20141%20222%209%22%20fill%3D%22none%22%20stroke%3D%22%23eee6fa%22%20stroke-width%3D%2214%22%2F%3E%3Cpath%20d%3D%22M299%20112Q300%20116%20304%20117Q300%20118%20299%20122Q298%20118%20294%20117Q298%20116%20299%20112%22%20fill%3D%22%23c5a9e4%22%2F%3E%3C%2Fsvg%3E\");--lr-frame:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22bezel%22%20x2%3D%22.8%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23c5a9e4%22%2F%3E%3Cstop%20offset%3D%22.27%22%20stop-color%3D%22white%22%2F%3E%3Cstop%20offset%3D%22.58%22%20stop-color%3D%22%23c5a9e4%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%237656a8%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2247%22%20fill%3D%22none%22%20stroke%3D%22url(%23bezel)%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M14%2034Q-2%2061%2017%2080Q5%2059%2014%2034M106%2034Q122%2061%20103%2080Q115%2059%20106%2034%22%20fill%3D%22%23c5a9e4%22%2F%3E%3Cpath%20d%3D%22M13%2025Q13.8%2028.2%2017%2029Q13.8%2029.8%2013%2033Q12.2%2029.8%209%2029Q12.2%2028.2%2013%2025%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M106%2083Q107%2087%20111%2088Q107%2089%20106%2093Q105%2089%20101%2088Q105%2087%20106%2083%22%20fill%3D%22%237656a8%22%2F%3E%3Cpath%20d%3D%22M31%20101Q60%20117%2089%20101%22%20fill%3D%22none%22%20stroke%3D%22%23c5a9e4%22%20stroke-width%3D%221.2%22%2F%3E%3Cpath%20d%3D%22M48%20104L60%2098L72%20104L60%20114Z%22%20fill%3D%22white%22%20stroke%3D%22%23c5a9e4%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20d%3D%22M60%20100Q61%20104%2065%20105Q61%20106%2060%20110Q59%20106%2055%20105Q59%20104%2060%20100%22%20fill%3D%22%237656a8%22%2F%3E%3C%2Fsvg%3E\");}\n.ab-root .ab-hero[data-relation-stage=\"4\"],.lr[data-relation-stage=\"4\"],.lr .persona-option[data-relation-stage=\"4\"]{--lr-tone:#ac4f84;--lr-signal:#ac4f84;--lr-light:#e4a3c8;--lr-tint:#fce7f2;--lr-edge:#e4a3c8;--lr-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20380%20230%22%3E%3Cellipse%20cx%3D%22200%22%20cy%3D%22207%22%20rx%3D%22146%22%20ry%3D%2211%22%20fill%3D%22%23e4a3c8%22%20opacity%3D%22.2%22%2F%3E%3Cpath%20d%3D%22M54%2051Q55.2%2055.8%2060%2057Q55.2%2058.2%2054%2063Q52.8%2058.2%2048%2057Q52.8%2055.8%2054%2051%22%20fill%3D%22%23e4a3c8%22%2F%3E%3Cpath%20d%3D%22M303%2045Q304.8%2052.2%20312%2054Q304.8%2055.8%20303%2063Q301.2%2055.8%20294%2054Q301.2%2052.2%20303%2045%22%20fill%3D%22%23e4a3c8%22%2F%3E%3Cpath%20d%3D%22M325%20142Q326%20146%20330%20147Q326%20148%20325%20152Q324%20148%20320%20147Q324%20146%20325%20142%22%20fill%3D%22%23ac4f84%22%2F%3E%3Ccircle%20cx%3D%22201%22%20cy%3D%22111%22%20r%3D%2282%22%20fill%3D%22%23fce7f2%22%2F%3E%3Cg%20transform%3D%22translate(107%2080)%20rotate(-10%2088%2055)%22%3E%3Crect%20width%3D%22174%22%20height%3D%22111%22%20rx%3D%229%22%20fill%3D%22white%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M2%20108L87%2039L172%20108%22%20fill%3D%22%23e4a3c8%22%20opacity%3D%22.36%22%2F%3E%3Cpath%20d%3D%22M2%204L87%2071L172%204%22%20fill%3D%22%23fce7f2%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20transform%3D%22translate(87%2065)%20scale(0.55)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23ac4f84%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(100%20197)%20rotate(-42)%20scale(1.1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23e4a3c8%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(98%20174)%20scale(0.67)%22%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(0)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(60)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(120)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(180)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(240)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(300)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Ccircle%20r%3D%2215%22%20fill%3D%22%23ac4f84%22%2F%3E%3Cpath%20d%3D%22M-8%20-4C8%20-18%2020%208%203%2010C-13%2013%20-12%20-8%200%20-8C9%20-8%208%205%200%205%22%20fill%3D%22none%22%20stroke%3D%22white%22%20opacity%3D%22.75%22%20stroke-width%3D%222%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(285%20174)%20scale(0.5)%22%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(0)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(60)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(120)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(180)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(240)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(300)%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221%22%2F%3E%3Ccircle%20r%3D%2215%22%20fill%3D%22%23ac4f84%22%2F%3E%3Cpath%20d%3D%22M-8%20-4C8%20-18%2020%208%203%2010C-13%2013%20-12%20-8%200%20-8C9%20-8%208%205%200%205%22%20fill%3D%22none%22%20stroke%3D%22white%22%20opacity%3D%22.75%22%20stroke-width%3D%222%22%2F%3E%3C%2Fg%3E%3Cpath%20d%3D%22M262%2057C220%2012%20219%2077%20262%2057C284%2011%20314%2072%20262%2057Z%22%20fill%3D%22%23e4a3c8%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221.4%22%2F%3E%3Cpath%20d%3D%22M262%2049L262%2068%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%222%22%2F%3E%3C%2Fsvg%3E\");--lr-header-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20440%20150%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22silk%22%20x2%3D%22.7%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23fce7f2%22%2F%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23e4a3c8%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ac4f84%22%20stop-opacity%3D%22.35%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20d%3D%22M12%20115C83%2040%20167%20155%20247%2090S365%2035%20415%2068%22%20fill%3D%22none%22%20stroke%3D%22url(%23silk)%22%20stroke-width%3D%2215%22%2F%3E%3Cpath%20d%3D%22M12%20109C83%2034%20167%20149%20247%2084S365%2029%20415%2062%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%221.5%22%20opacity%3D%22.9%22%2F%3E%3Cg%20transform%3D%22translate(252%2074)%20rotate(-12)%22%3E%3Cpath%20d%3D%22M0%200C-77%20-59%20-72%2033%20-5%205L-25%2046L-6%2038L7%2049L7%208C79%2054%2082%20-53%200%200Z%22%20fill%3D%22url(%23silk)%22%20stroke%3D%22%23e4a3c8%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20d%3D%22M-5%203Q-43%20-25%20-55%20-16M6%203Q44%20-19%2054%20-14%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%2F%3E%3Cellipse%20rx%3D%229%22%20ry%3D%227%22%20fill%3D%22%23ac4f84%22%2F%3E%3C%2Fg%3E%3Cpath%20transform%3D%22translate(113%2048)%20scale(0.24)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23e4a3c8%22%2F%3E%3Cpath%20transform%3D%22translate(357%20101)%20scale(0.3)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23e4a3c8%22%2F%3E%3C%2Fsvg%3E\");--lr-frame:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22bezel%22%20x2%3D%22.8%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23e4a3c8%22%2F%3E%3Cstop%20offset%3D%22.27%22%20stop-color%3D%22white%22%2F%3E%3Cstop%20offset%3D%22.58%22%20stop-color%3D%22%23e4a3c8%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ac4f84%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2247%22%20fill%3D%22none%22%20stroke%3D%22url(%23bezel)%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M12%2068Q2%2075%2010%2085L27%20101L19%2084ZM108%2068Q118%2075%20110%2085L93%20101L101%2084Z%22%20fill%3D%22url(%23bezel)%22%2F%3E%3Cpath%20d%3D%22M29%2098Q39%20111%2053%20105M91%2098Q81%20111%2067%20105%22%20fill%3D%22none%22%20stroke%3D%22%23ac4f84%22%20stroke-width%3D%221.3%22%2F%3E%3Cpath%20d%3D%22M15%2029Q15.8%2032.2%2019%2033Q15.8%2033.8%2015%2037Q14.2%2033.8%2011%2033Q14.2%2032.2%2015%2029%22%20fill%3D%22%23e4a3c8%22%2F%3E%3Cpath%20d%3D%22M106%2030Q106.8%2033.2%20110%2034Q106.8%2034.8%20106%2038Q105.2%2034.8%20102%2034Q105.2%2033.2%20106%2030%22%20fill%3D%22%23e4a3c8%22%2F%3E%3Cpath%20d%3D%22M48%20104L60%2098L72%20104L60%20114Z%22%20fill%3D%22white%22%20stroke%3D%22%23e4a3c8%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20transform%3D%22translate(60%20106)%20scale(0.24)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23ac4f84%22%2F%3E%3C%2Fsvg%3E\");}\n.ab-root .ab-hero[data-relation-stage=\"5\"],.lr[data-relation-stage=\"5\"],.lr .persona-option[data-relation-stage=\"5\"]{--lr-tone:#ca4b7b;--lr-signal:#ca4b7b;--lr-light:#f1aec5;--lr-tint:#ffe5ee;--lr-edge:#f1aec5;--lr-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20380%20230%22%3E%3Cellipse%20cx%3D%22200%22%20cy%3D%22207%22%20rx%3D%22146%22%20ry%3D%2211%22%20fill%3D%22%23f1aec5%22%20opacity%3D%22.2%22%2F%3E%3Cpath%20d%3D%22M54%2051Q55.2%2055.8%2060%2057Q55.2%2058.2%2054%2063Q52.8%2058.2%2048%2057Q52.8%2055.8%2054%2051%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M303%2045Q304.8%2052.2%20312%2054Q304.8%2055.8%20303%2063Q301.2%2055.8%20294%2054Q301.2%2052.2%20303%2045%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M325%20142Q326%20146%20330%20147Q326%20148%20325%20152Q324%20148%20320%20147Q324%20146%20325%20142%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Ccircle%20cx%3D%22193%22%20cy%3D%22109%22%20r%3D%2285%22%20fill%3D%22%23ffe5ee%22%2F%3E%3Cg%20transform%3D%22translate(107%20177)%20rotate(-62)%20scale(1.25)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(92%20145)%20rotate(-50)%20scale(1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(91%20110)%20rotate(-27)%20scale(1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(102%2079)%20rotate(-10)%20scale(0.8)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(281%20177)%20rotate(62)%20scale(1.25)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(294%20145)%20rotate(50)%20scale(1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(296%20110)%20rotate(27)%20scale(1)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(282%2079)%20rotate(10)%20scale(0.8)%22%3E%3Cpath%20d%3D%22M0%200C-20%20-6%20-24%20-30%20-2%20-42C17%20-28%2019%20-9%200%200%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M0%20-3L-2%20-34%22%20stroke%3D%22white%22%20opacity%3D%22.6%22%20fill%3D%22none%22%2F%3E%3C%2Fg%3E%3Cpath%20transform%3D%22translate(193%20116)%20scale(2.35)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20transform%3D%22translate(187%20105)%20scale(1.9)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M126%20165Q194%20189%20261%20165L257%20192Q194%20212%20130%20191Z%22%20fill%3D%22white%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%222%22%2F%3E%3Cg%20transform%3D%22translate(136%20180)%20scale(0.63)%22%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(0)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(60)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(120)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(180)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(240)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(300)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Ccircle%20r%3D%2215%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M-8%20-4C8%20-18%2020%208%203%2010C-13%2013%20-12%20-8%200%20-8C9%20-8%208%205%200%205%22%20fill%3D%22none%22%20stroke%3D%22white%22%20opacity%3D%22.75%22%20stroke-width%3D%222%22%2F%3E%3C%2Fg%3E%3Cg%20transform%3D%22translate(251%20180)%20scale(0.63)%22%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(0)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(60)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(120)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(180)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(240)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Cellipse%20rx%3D%2212%22%20ry%3D%2221%22%20cy%3D%22-10%22%20transform%3D%22rotate(300)%22%20fill%3D%22%23f1aec5%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221%22%2F%3E%3Ccircle%20r%3D%2215%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M-8%20-4C8%20-18%2020%208%203%2010C-13%2013%20-12%20-8%200%20-8C9%20-8%208%205%200%205%22%20fill%3D%22none%22%20stroke%3D%22white%22%20opacity%3D%22.75%22%20stroke-width%3D%222%22%2F%3E%3C%2Fg%3E%3Cpath%20d%3D%22M194%2035Q195.8%2042.2%20203%2044Q195.8%2045.8%20194%2053Q192.2%2045.8%20185%2044Q192.2%2042.2%20194%2035%22%20fill%3D%22white%22%2F%3E%3C%2Fsvg%3E\");--lr-header-scene:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20440%20150%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22silk%22%20x2%3D%22.7%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23ffe5ee%22%2F%3E%3Cstop%20offset%3D%22.45%22%20stop-color%3D%22%23f1aec5%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ca4b7b%22%20stop-opacity%3D%22.35%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Cpath%20d%3D%22M12%20115C83%2040%20167%20155%20247%2090S365%2035%20415%2068%22%20fill%3D%22none%22%20stroke%3D%22url(%23silk)%22%20stroke-width%3D%2215%22%2F%3E%3Cpath%20d%3D%22M12%20109C83%2034%20167%20149%20247%2084S365%2029%20415%2062%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%221.5%22%20opacity%3D%22.9%22%2F%3E%3Cg%20transform%3D%22translate(240%2074)%20rotate(-18)%22%3E%3Cellipse%20cx%3D%22-24%22%20rx%3D%2237%22%20ry%3D%2230%22%20fill%3D%22none%22%20stroke%3D%22%23f1aec5%22%20stroke-width%3D%227%22%2F%3E%3Cellipse%20cx%3D%2226%22%20rx%3D%2237%22%20ry%3D%2230%22%20fill%3D%22none%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%227%22%2F%3E%3Cpath%20d%3D%22M14%20-31L26%20-44L38%20-31L26%20-20Z%22%20fill%3D%22white%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M-51%20-14Q-29%20-32%20-8%20-17M2%20-14Q24%20-32%2049%20-17%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%2F%3E%3C%2Fg%3E%3Cpath%20d%3D%22M119%2040Q120.4%2045.6%20126%2047Q120.4%2048.4%20119%2054Q117.6%2048.4%20112%2047Q117.6%2045.6%20119%2040%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M351%2098Q352.8%20105.2%20360%20107Q352.8%20108.8%20351%20116Q349.2%20108.8%20342%20107Q349.2%20105.2%20351%2098%22%20fill%3D%22%23f1aec5%22%2F%3E%3C%2Fsvg%3E\");--lr-frame:url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22bezel%22%20x2%3D%22.8%22%20y2%3D%221%22%3E%3Cstop%20stop-color%3D%22%23f1aec5%22%2F%3E%3Cstop%20offset%3D%22.27%22%20stop-color%3D%22white%22%2F%3E%3Cstop%20offset%3D%22.58%22%20stop-color%3D%22%23f1aec5%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23ca4b7b%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2247%22%20fill%3D%22none%22%20stroke%3D%22url(%23bezel)%22%20stroke-width%3D%223.5%22%2F%3E%3Cpath%20d%3D%22M12%2059L4%2055L7%2077L25%2099L17%2076ZM108%2059L116%2055L113%2077L95%2099L103%2076Z%22%20fill%3D%22url(%23bezel)%22%2F%3E%3Cpath%20d%3D%22M20%2087Q24%20109%2049%20108M100%2087Q96%20109%2071%20108%22%20fill%3D%22none%22%20stroke%3D%22%23ca4b7b%22%20stroke-width%3D%221.5%22%2F%3E%3Cpath%20d%3D%22M13%2030Q13.8%2033.2%2017%2034Q13.8%2034.8%2013%2038Q12.2%2034.8%209%2034Q12.2%2033.2%2013%2030%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M107%2030Q107.8%2033.2%20111%2034Q107.8%2034.8%20107%2038Q106.2%2034.8%20103%2034Q106.2%2033.2%20107%2030%22%20fill%3D%22%23ca4b7b%22%2F%3E%3Cpath%20d%3D%22M53%2012L60%205L67%2012Z%22%20fill%3D%22%23f1aec5%22%2F%3E%3Cpath%20d%3D%22M48%20104L60%2098L72%20104L60%20114Z%22%20fill%3D%22white%22%20stroke%3D%22%23f1aec5%22%20stroke-width%3D%221%22%2F%3E%3Cpath%20transform%3D%22translate(60%20106)%20scale(0.24)%22%20d%3D%22M0%2016C-12%207%20-25%20-2%20-25%20-14C-25%20-32%20-6%20-35%200%20-21C6%20-35%2025%20-32%2025%20-14C25%20-2%2012%207%200%2016Z%22%20fill%3D%22%23ca4b7b%22%2F%3E%3C%2Fsvg%3E\");}";
const relationPanelStyle=".lr {\n  --surface: var(--ab-card, #fff);\n  --ink: var(--ab-text, #1d2939);\n  --muted: var(--ab-sub, #556377);\n  --line: var(--ab-line, #dce3ec);\n  --blue: var(--ab-sea, #3474c4);\n  --blue-wash: color-mix(in srgb, var(--blue) 9%, var(--surface));\n  --mild: color-mix(in srgb, var(--muted) 5%, var(--surface));\n  --stage-wash: color-mix(in srgb, var(--lr-signal, #3883db) 9%, var(--surface));\n  --stage-ink: color-mix(in srgb, var(--lr-tone, #3976b8) 78%, var(--ink));\n  --control: 40px;\n  display: grid;\n  grid-column: 1 / -1;\n  gap: 18px;\n  width: 100%;\n  min-width: 0;\n  padding: 4px 0 20px;\n  color: var(--ink);\n  font: inherit;\n  font-size: 14px;\n  line-height: 1.55;\n}\n.lr *, .lr *::before, .lr *::after { box-sizing: border-box; }\n.lr :is(h2, h3, h4, p, pre, blockquote) { margin: 0; }\n.lr h2 { font-size: 22px; line-height: 1.3; font-weight: 660; }\n.lr h3 { font-size: 16px; line-height: 1.35; font-weight: 650; }\n.lr small, .lr .hint { color: var(--muted); font-size: 12px; line-height: 1.5; }\n.lr :is(p, small, label, blockquote, pre, td, th) { overflow-wrap: anywhere; }\n.lr :is(.head, .module-title, .section-title) { display: grid; gap: 4px; min-width: 0; }\n.lr .stack { display: grid; min-width: 0; gap: 14px; }\n.lr .row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }\n.lr .between { justify-content: space-between; }\n.lr .grow { min-width: 0; flex: 1 1 auto; }\n.lr .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; align-items: start; }\n.lr .card {\n  min-width: 0;\n  padding: 20px;\n  background: var(--surface);\n  border: 1px solid var(--line);\n  border-radius: 14px;\n  box-shadow: var(--ab-shadow, 0 2px 10px #253e6410);\n}\n.lr :is(button, input, textarea, select) { font: inherit; color: inherit; min-width: 0; }\n.lr :is(button, input, textarea, select, summary):focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }\n.lr button {\n  min-height: var(--control);\n  padding: 0 13px;\n  border: 1px solid var(--line);\n  border-radius: 8px;\n  background: var(--surface);\n  font-size: 13px;\n  cursor: pointer;\n}\n.lr button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--blue) 35%, var(--line)); background: var(--blue-wash); }\n.lr button:disabled { color: var(--muted); background: var(--mild); cursor: default; opacity: .74; }\n.lr button.primary { border-color: var(--blue); background: var(--blue); color: #fff; font-weight: 580; }\n.lr button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--blue) 88%, #000); }\n.lr button.primary:disabled { border-color: var(--line); background: var(--mild); color: var(--muted); }\n.lr button.quiet { background: transparent; border-color: transparent; }\n.lr button.danger { color: #ab3a4b; }\n.lr .field { display: grid; grid-template-rows: auto auto auto; justify-items: stretch; align-items: start; gap: 6px; min-width: 0; }\n.lr .field-title { line-height: 1.45; font-size: 13px; font-weight: 610; align-self: end; }\n.lr .field-help:empty { display: none; }\n.lr :is(input:not([type=\"checkbox\"]), select, textarea) {\n  display: block;\n  width: 100%;\n  border: 1px solid var(--line);\n  border-radius: 8px;\n  padding: 0 11px;\n  background: var(--surface);\n  color: var(--ink);\n  font-size: 13px;\n}\n.lr :is(input:not([type=\"checkbox\"]), select) { height: var(--control); }\n.lr input[type=\"file\"] { padding: 7px; }\n.lr textarea { padding: 9px 11px; min-height: 88px; resize: vertical; }\n.lr input::placeholder { color: var(--muted); }\n.lr .check { min-height: 29px; display: flex; align-items: flex-start; gap: 9px; line-height: 1.5; }\n.lr .check input { accent-color: var(--blue); margin: 4px 0 0; }\n@supports (grid-template-rows: subgrid) {\n  .lr .grid:has(> .field) { row-gap: 6px; align-items: stretch; }\n  .lr .grid > .field { grid-row: span 3; grid-template-rows: subgrid; row-gap: 6px; }\n}\n\n.lr .module-head { padding: 3px 0 4px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 16px; align-items: center; }\n.lr .overview-tools, .lr .header-tools { display: flex; align-items: center; gap: 8px; min-width: 0; }\n.lr .header-tools { justify-content: flex-end; }\n.lr .relationship-switches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 238px; gap: 8px; }\n.lr .switch-tile {\n  display: flex; align-items: center; justify-content: space-between; gap: 5px;\n  min-height: var(--control); padding: 0 9px;\n  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);\n  color: var(--ink); font-size: 12px; white-space: nowrap;\n}\n.lr .lr-icon { display: inline-grid; place-items: center; flex: none; line-height: 1; }\n.lr .tool-action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding-inline: 11px; white-space: nowrap; }\n.lr .tool-icon { font-size: 15px; color: var(--muted); }\n.lr .settings-action { background: var(--blue-wash); border-color: color-mix(in srgb,var(--blue) 21%,var(--line)); color: var(--ink); }\n.lr .settings-action .tool-icon { color: var(--blue); }\n.lr .lr-switch { position: relative; display: block; width: 40px; height: 24px; flex: none; }\n.lr .lr-switch input { position: absolute; inset: 0; z-index: 1; margin: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }\n.lr .lr-switch > span { position: absolute; inset: 0; border-radius: 999px; background: color-mix(in srgb, var(--muted) 22%, var(--surface)); }\n.lr .lr-switch > span::after { content: \"\"; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0002; transition: transform .16s ease; }\n.lr .lr-switch input:checked + span { background: linear-gradient(135deg,var(--lr-signal,var(--blue)),var(--lr-tone,var(--blue))); }\n.lr .lr-switch input:checked + span::after { transform: translateX(16px); }\n.lr .lr-switch input:focus-visible + span { outline: 2px solid var(--blue); outline-offset: 3px; }\n.lr .lr-switch input:disabled + span { opacity: .58; }\n\n.lr .relation-workspace { display: grid; grid-template-columns: 208px minmax(0, 1fr); align-items: start; gap: 18px; min-width: 0; }\n.lr .persona-list { display: grid; gap: 12px; padding: 14px; }\n.lr .persona-list-title { display: flex; justify-content: space-between; align-items: center; min-height: 23px; }\n.lr .persona-list-title h3 { font-size: 14px; }\n.lr .persona-options { display: grid; gap: 5px; min-width: 0; }\n.lr button.persona-option {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  min-height: 62px;\n  width: 100%;\n  padding: 8px 9px;\n  background: transparent;\n  border-color: transparent;\n  text-align: left;\n}\n.lr button.persona-option[aria-pressed=\"true\"] { background: var(--blue-wash); border-color: color-mix(in srgb, var(--blue) 24%, var(--line)); }\n.lr .persona-initial { flex: 0 0 32px; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--mild); color: var(--muted); font-weight: 650; }\n.lr button.persona-option[aria-pressed=\"true\"] .persona-initial { background: var(--surface); color: var(--blue); }\n.lr .persona-copy { flex: 1; min-width: 0; display: grid; gap: 3px; }\n.lr .persona-copy strong { font-size: 13px; font-weight: 630; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.lr .persona-meta { display: flex; gap: 4px 6px; align-items: center; flex-wrap: wrap; }\n.lr .persona-meta .running { color: var(--blue); white-space: nowrap; font-size: 11px; }\n.lr .persona-copy :is(strong, small) { overflow-wrap: anywhere; }\n.lr .relation-main { display: grid; width: 100%; min-width: 0; margin: 0; gap: 14px; align-content: start; }\n.lr .persona-heading { min-height: 36px; padding: 0 2px; }\n.lr .persona-heading h3 { font-size: 17px; }\n\n.lr .relationship-hero {\n  position: relative;\n  isolation: isolate;\n  display: grid;\n  grid-template-columns: minmax(0,1fr) auto;\n  align-items: start;\n  column-gap: 24px;\n  row-gap: 19px;\n  min-width: 0;\n  overflow: hidden;\n  padding: 23px 24px 19px;\n  border-color: color-mix(in srgb,var(--lr-signal) 24%,var(--line));\n  background:\n    radial-gradient(116% 160% at 1% -6%,color-mix(in srgb,var(--lr-signal) 19%,transparent),transparent 57%),\n    radial-gradient(68% 105% at 95% 100%,color-mix(in srgb,var(--lr-light) 20%,transparent),transparent 78%),\n    var(--surface);\n}\n.lr .relationship-art {\n  position:absolute; z-index:-1; right:18px; top:-40px; width:min(48%,370px); height:210px;\n  transform:rotate(-13deg); pointer-events:none;\n}\n.lr .relationship-art::before, .lr .relationship-art::after {\n  position:absolute; content:\"\"; inset:29% 4% 11%;\n  border:1px solid color-mix(in srgb,var(--lr-signal) 20%,transparent); border-radius:50%;\n}\n.lr .relationship-art::after {\n  content:var(--lr-crest); display:grid; place-items:center; transform:rotate(28deg);\n  font-size:clamp(30px,5vw,58px); color:color-mix(in srgb,var(--lr-signal) 17%,transparent);\n}\n.lr .relationship-art i { position:absolute; width:5px; height:5px; border-radius:50%; background:var(--lr-light); }\n.lr .relationship-art i:nth-child(1) { top:45%; left:18%; }\n.lr .relationship-art i:nth-child(2) { top:38%; right:18%; width:7px; height:7px; }\n.lr .relationship-art i:nth-child(3) { bottom:14%; left:47%; }\n.lr .relationship-title { display:grid; justify-items:start; gap:4px; min-width:0; }\n.lr .relationship-title > .row { gap:7px; }\n.lr .relationship-crest {\n  width:22px; height:22px; display:grid; place-items:center; border-radius:7px;\n  background:color-mix(in srgb,var(--lr-signal) 16%,var(--surface)); color:var(--stage-ink);\n}\n.lr .relationship-crest::after { content:var(--lr-crest); font-size:12px; line-height:1; }\n.lr .stage-caption { font-size:12px; color:var(--muted); font-weight:600; }\n.lr .relationship-title h3 { font-size:clamp(25px,3vw,35px); line-height:1.15; letter-spacing:.015em; overflow-wrap:anywhere; }\n.lr .stage-meaning { color:var(--muted); font-size:13px; }\n.lr .relationship-score { text-align:right; min-width:74px; white-space:nowrap; padding-top:7px; }\n.lr .relationship-score div { display:flex; gap:4px; align-items:baseline; justify-content:flex-end; }\n.lr .relationship-score strong { font-size:clamp(29px,4vw,47px); line-height:1.08; font-weight:680; color:var(--stage-ink); letter-spacing:-.035em; font-variant-numeric:tabular-nums; }\n.lr .relationship-score span { color:var(--muted); font-size:12px; }\n.lr .stage-journey {\n  position:relative; grid-column:1/-1; display:grid; grid-template-columns:repeat(5,minmax(0,1fr));\n  min-width:0; padding:2px 0 3px;\n  border:1px solid color-mix(in srgb,var(--lr-signal) 14%,var(--line)); border-radius:16px;\n  background:color-mix(in srgb,var(--surface) 78%,transparent);\n}\n.lr .journey-track {\n  position:absolute; left:10%; right:10%; top:22px; height:5px; border-radius:999px; overflow:hidden;\n  background:color-mix(in srgb,var(--lr-signal) 12%,var(--line));\n}\n.lr .journey-track > span {\n  display:block; width:100%; height:100%;\n  background:linear-gradient(90deg,#438add,#409b90 25%,#8972c9 50%,#bf6599 75%,#dc598e);\n  clip-path:inset(0 calc(100% - var(--fill)) 0 0 round 999px);\n}\n.lr button.journey-step {\n  display:grid; align-content:start; justify-items:center; gap:6px; min-width:0; min-height:67px;\n  position:relative; padding:14px 3px 5px; margin:0; border:1px solid transparent;\n  border-radius:11px; background:transparent; color:var(--muted); font-size:12px;\n  text-align:center; overflow-wrap:anywhere; line-height:1.35;\n}\n.lr button.journey-step:hover:not(:disabled) { background:var(--stage-wash); border-color:transparent; }\n.lr button.journey-step[aria-current=\"step\"] { color:var(--stage-ink); font-weight:690; }\n.lr button.journey-step[data-located=\"true\"] { outline:2px solid var(--lr-signal); outline-offset:-2px; }\n.lr .journey-step[data-step=\"1\"] { --road:#438add; }\n.lr .journey-step[data-step=\"2\"] { --road:#409b90; }\n.lr .journey-step[data-step=\"3\"] { --road:#8972c9; }\n.lr .journey-step[data-step=\"4\"] { --road:#bf6599; }\n.lr .journey-step[data-step=\"5\"] { --road:#dc598e; }\n.lr .journey-marker {\n  width:14px; height:14px; border:2px solid var(--surface); border-radius:50%;\n  background:color-mix(in srgb,var(--muted) 14%,var(--surface));\n  box-shadow:0 0 0 1px color-mix(in srgb,var(--lr-signal) 20%,var(--line));\n}\n.lr .journey-step[data-reached] .journey-marker { background:var(--road); box-shadow:0 0 0 1px var(--road); }\n.lr .journey-step[aria-current=\"step\"] .journey-marker {\n  box-shadow:0 0 0 1px var(--road),0 0 0 4px color-mix(in srgb,var(--road) 21%,transparent);\n}\n.lr .relationship-signals { grid-column:1/-1; display:flex; justify-content:flex-end; align-items:stretch; flex-wrap:wrap; gap:8px; min-width:0; }\n.lr .relationship-signal {\n  display:grid; grid-template-columns:26px minmax(0,auto); align-items:center; gap:0 8px;\n  max-width:min(100%,320px); min-width:130px; padding:6px 9px; border-radius:10px;\n  border:1px solid color-mix(in srgb,var(--lr-signal) 16%,var(--line));\n  background:color-mix(in srgb,var(--surface) 86%,transparent);\n}\n.lr .mood-signal { grid-template-columns:26px minmax(0,auto) auto; }\n.lr .signal-icon { width:26px; height:26px; border-radius:8px; color:var(--stage-ink); background:var(--stage-wash); font-size:15px; }\n.lr .relationship-signal > div { min-width:0; display:grid; gap:0; }\n.lr .relationship-signal small { font-size:11px; }\n.lr .relationship-signal strong { font-size:12px; line-height:1.35; overflow-wrap:anywhere; }\n.lr .mood-value { align-self:end; color:var(--muted); font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums; }\n.lr .badge { border-radius:999px; padding:2px 7px; background:var(--mild); color:var(--muted); font-size:12px; overflow-wrap:anywhere; }\n.lr .badge.on { background:var(--stage-wash); color:var(--stage-ink); }\n\n.lr .settings-cards { display:grid; gap:10px; }\n.lr .settings-card { padding:0; overflow:clip; }\n.lr button.settings-card-trigger {\n  width:100%; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:11px; align-items:center;\n  text-align:left; min-height:60px; padding:10px 15px; border:0; border-radius:0; background:var(--surface);\n}\n.lr button.settings-card-trigger[aria-expanded=\"true\"] { background:var(--stage-wash); }\n.lr .setting-icon { width:33px; height:33px; color:var(--stage-ink); border-radius:10px; background:var(--stage-wash); font-size:18px; }\n.lr .setting-card-copy { display:grid; gap:1px; min-width:0; }\n.lr .setting-card-copy strong { font-size:14px; }\n.lr .expand-indicator, .lr .support-toggle::after {\n  width:7px; height:7px; margin-right:4px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:rotate(-45deg);\n}\n.lr button[aria-expanded=\"true\"] > .expand-indicator, .lr .support-toggle[aria-expanded=\"true\"]::after { transform:rotate(45deg) translateY(-2px); }\n.lr .settings-card-body { padding:16px; min-width:0; border-top:1px solid var(--line); }\n.lr .support-group { border:1px solid var(--line); border-radius:9px; min-width:0; }\n.lr .support-toggle { width:100%; display:flex; justify-content:space-between; align-items:center; text-align:left; border:0; }\n.lr .support-toggle::after { content:\"\"; flex:none; }\n.lr .support-body { padding:5px 12px 12px; min-width:0; }\n\n.lr .relation-dialog {\n  width:min(480px,calc(100% - 32px)); max-height:min(85vh,640px); margin:auto; overflow:auto;\n  padding:20px; color:var(--ink); background:var(--surface);\n  border:1px solid var(--line); border-radius:16px; box-shadow:0 14px 50px #16243840;\n}\n.lr .relation-dialog::backdrop { background:#19294265; }\n.lr .dialog-actions { justify-content:flex-end; }\n\n.lr details.fold { border-top: 1px solid var(--line); min-width: 0; }\n.lr details.fold > summary { display: flex; align-items: center; gap: 9px; min-height: 43px; padding: 8px 3px; font-size: 13px; font-weight: 590; list-style: none; cursor: pointer; color: var(--ink); }\n.lr details.fold > summary::-webkit-details-marker, .lr .event > summary::-webkit-details-marker { display: none; }\n.lr details.fold > summary::before { content: \"\"; width: 5px; height: 5px; flex: none; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(-45deg); }\n.lr details.fold[open] > summary::before { transform: rotate(45deg) translateY(-1px); }\n.lr details.fold > .stack { padding: 6px 4px 13px; }\n.lr .stack > .fold + .fold { margin-top: -14px; }\n.lr .extras { display: grid; gap: 10px; }\n.lr .extras > div:has(> details.fold) + div:has(> details.fold) { margin-top: -10px; }\n.lr .extras .grid > div { min-width: 0; }\n.lr :is(pre, blockquote) { padding: 9px 11px; border-radius: 7px; background: var(--mild); white-space: pre-wrap; font: inherit; font-size: 13px; }\n.lr blockquote { border-left: 2px solid color-mix(in srgb, var(--lr-tone) 46%, var(--line)); }\n.lr .diff-scroll { max-height: 360px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }\n.lr .diff-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }\n.lr .diff-table :is(td, th) { padding: 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }\n.lr .diff-table th small { display: block; font-weight: 400; }\n.lr .timeline-card { display: grid; gap: 12px; }\n.lr .timeline-heading { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; }\n.lr .timeline-heading h3 { display:flex; align-items:center; gap:9px; scroll-margin-block-start:105px; }\n.lr .timeline-heading h3::before { content:\"\"; width:4px; height:16px; border-radius:4px; flex:none; background:linear-gradient(var(--lr-light),var(--lr-signal)); }\n.lr .timeline-actions { display:flex; gap:6px; align-items:center; }\n.lr .timeline-filter { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }\n.lr .timeline-filter select { width:114px; }\n.lr .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }\n.lr .timeline-selection { justify-content:space-between; padding:2px 7px 2px 10px; border-radius:8px; background:var(--stage-wash); color:var(--stage-ink); font-size:12px; }\n.lr .timeline-selection button { min-height:30px; font-size:12px; }\n.lr .timeline { position:relative; display:grid; gap:9px; padding-left:22px; }\n.lr .timeline::before { content:\"\"; position:absolute; top:22px; bottom:22px; left:5px; width:1px; background:color-mix(in srgb,var(--lr-signal) 32%,var(--line)); }\n.lr .event { min-width:0; border:1px solid color-mix(in srgb,var(--lr-signal) 10%,var(--line)); border-radius:11px; background:color-mix(in srgb,var(--stage-wash) 42%,var(--surface)); }\n.lr .event[open] { background:var(--surface); }\n.lr .event > summary { position:relative; display:flex; justify-content:space-between; align-items:center; list-style:none; gap:10px; min-height:59px; padding:9px 12px; cursor:pointer; border-radius:11px; }\n.lr .event > summary::before { content:\"\"; position:absolute; left:-22px; top:21px; width:9px; height:9px; border:2px solid var(--lr-signal); border-radius:50%; background:var(--surface); }\n.lr .event > summary::after {\n  content:\"\"; width:6px; height:6px; flex:none; margin:0 2px; transform:rotate(-45deg);\n  border-inline-end:1.5px solid var(--muted); border-block-end:1.5px solid var(--muted);\n}\n.lr .event[open] > summary::after { transform:rotate(45deg) translateY(-1px); }\n.lr .event > summary:hover { background:var(--stage-wash); }\n.lr .event > summary small { display:block; margin-bottom:3px; }\n.lr .event-name { font-weight:600; font-size:13px; overflow-wrap:anywhere; }\n.lr .event-body { padding:5px 12px 12px; gap:9px; }\n.lr .event-progress { justify-content: space-between; }\n.lr .event-body > div > p { margin-bottom: 4px; }\n.lr .delta { flex:none; padding:3px 8px; border-radius:999px; background:var(--mild); font-size:12px; font-weight:650; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap; }\n.lr .delta.up { color:color-mix(in srgb,#287257 72%,var(--ink)); background:color-mix(in srgb,#369874 12%,var(--surface)); }\n.lr .delta.down { color:color-mix(in srgb,#ab4258 78%,var(--ink)); background:color-mix(in srgb,#c85b71 12%,var(--surface)); }\n.lr .pagination { padding-top: 11px; border-top: 1px solid var(--line); }\n.lr .empty { display: grid; justify-items: start; gap: 8px; padding: 22px 0; color: var(--muted); }\n.lr .empty.card { padding: 20px; }\n.lr .notice { padding: 10px 13px; border: 1px solid var(--line); border-radius: 9px; background: var(--blue-wash); font-size: 13px; }\n.lr .notice.warn { background: color-mix(in srgb, #e2a56b 12%, var(--surface)); }\n.lr .footer { padding: 0 2px; text-align: right; }\n\n@media (max-width: 820px) { .lr .relation-workspace { grid-template-columns: 184px minmax(0, 1fr); gap: 14px; } }\n@media (max-width: 660px) {\n  .lr { gap: 14px; }\n  .lr .module-head { gap:8px; padding:0; }\n  .lr .module-head h2 { font-size: 19px; }\n  .lr .overview-tools { display:contents; }\n  .lr .header-tools { grid-column:2; grid-row:1; gap:5px; flex-wrap:wrap; }\n  .lr .header-tools > button { padding-inline:8px; }\n  .lr .relationship-switches { grid-column:1/-1; grid-row:2; width:100%; }\n  .lr .switch-tile { padding:0 11px; }\n  .lr .relation-workspace { grid-template-columns: minmax(0, 1fr); }\n  .lr .persona-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n  .lr .persona-list { gap: 8px; padding: 11px; }\n  .lr .persona-option { min-height: 59px; }\n  .lr .card:not(.persona-list,.settings-card) { padding:15px; }\n  .lr .relationship-hero { column-gap:10px; row-gap:13px; }\n  .lr .relationship-art { right:-17px; top:-52px; width:50%; }\n}\n@media (max-width: 490px) {\n  .lr .grid { grid-template-columns: minmax(0, 1fr); }\n  .lr .grid:has(> .field) { row-gap: 12px; }\n  .lr .grid > .field { grid-row: auto; grid-template-rows: auto auto auto; }\n  .lr .timeline-heading { gap:6px; }\n  .lr .timeline-filter select { width:92px; padding-inline:6px; }\n  .lr .timeline-actions > button { padding:0 6px; }\n  .lr .relationship-signals { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }\n  .lr .relationship-signal { grid-template-columns:22px minmax(0,1fr); min-width:0; max-width:none; gap:0 5px; padding:5px 7px; }\n  .lr .signal-icon { width:22px; height:22px; }\n  .lr .mood-value { grid-column:2; }\n  .lr .settings-card-body { padding:12px; }\n}\n@media (max-width: 355px) {\n  .lr .module-head h2 { font-size:17px; }\n}\n@media (prefers-reduced-motion: reduce) { .lr .lr-switch > span::after { transition: none; } }\n\n.lr .settings-section { display:grid; gap:12px; min-width:0; padding-top:14px; border-top:1px solid var(--line); }\n.lr .settings-section h4 { font-size:13px; color:var(--ink); font-weight:650; }\n.lr .support-body { padding:0; display:grid; gap:18px; }\n.lr .settings-section .settings-section { border:0; padding:8px 0 0; }\n.lr .config-editor .config-object { grid-column:1/-1; }\n.lr .config-editor .config-value > .check { min-height:62px; align-items:center; }\n.lr .extras .check input { flex:none; width:auto; margin:3px 0 0; }\n.lr .intimacy-switches { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }\n.lr .switch-setting { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:13px; background:var(--stage-wash); border-radius:10px; }\n.lr .switch-setting strong { font-size:13px; }\n.lr .tendency-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }\n.lr .module-head .overview-tools { justify-content:flex-end; }\n.lr .relationship-hero { min-height:330px; padding:28px 26px 20px; row-gap:24px; border-radius:20px; background:radial-gradient(ellipse at 0% 0%,var(--lr-tint),transparent 68%),var(--surface); }\n.lr .relationship-art { transform:none; inset:3px 70px auto auto; width:320px; height:198px; background:var(--lr-scene) center/contain no-repeat; opacity:.8; }\n.lr .relationship-art::before,.lr .relationship-art::after { display:none; }\n.lr .relationship-title { min-height:124px; align-content:start; }\n.lr .relationship-title h3 { margin-top:6px; font-size:36px; letter-spacing:.04em; }\n.lr .relationship-title .relationship-crest { display:none; }\n.lr .relationship-score { padding-top:10px; position:relative; }\n.lr .stage-journey { border:0; border-radius:0; background:transparent; }\n.lr .journey-track { top:19px; height:4px; z-index:-1; }\n.lr button.journey-step { min-height:62px; padding-top:10px; border:0; border-radius:0; background:transparent; box-shadow:none; }\n.lr button.journey-step:hover:not(:disabled) { background:transparent; border-color:transparent; color:var(--stage-ink); }\n.lr button.journey-step:hover .journey-marker { transform:scale(1.18); }\n.lr .journey-marker { width:18px; height:18px; transition:transform .15s; }\n.lr button.journey-step[data-located] { outline:0; }\n.lr button.journey-step[data-located] > span:last-child { text-decoration:underline; text-underline-offset:4px; }\n.lr .relationship-actions { grid-column:1/-1; display:flex; align-items:center; gap:16px; justify-content:space-between; }\n.lr .persona-actions { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; width:min(100%,360px); }\n.lr .persona-actions > button { display:flex; align-items:center; justify-content:center; gap:6px; height:36px; min-height:36px; min-width:0; border-radius:8px; line-height:1; font-size:12px; padding:0 10px; font-weight:500; border-color:color-mix(in srgb,var(--lr-tone) 12%,var(--line)); background:color-mix(in srgb,var(--surface) 90%,transparent); box-shadow:0 1px 2px #18243a04; }\n.lr .persona-actions > button:hover:not(:disabled) { background:var(--lr-tint); border-color:var(--lr-light); }\n.lr .persona-actions > button.primary { color:#fff; background:#3b7edb; border-color:#3b7edb; box-shadow:0 2px 5px #3b7edb18; }\n.lr .persona-actions > button.primary:hover:not(:disabled) { background:#326fc7; border-color:#326fc7; }\n.lr .initiative-indicator { width:5px; height:5px; flex:none; border-radius:50%; background:#b9bec6; }\n.lr .initiative-action[data-active] .initiative-indicator { background:var(--lr-tone); box-shadow:0 0 0 3px var(--lr-tint); }\n.lr .appearance-switch { height:36px; min-height:36px; border-color:transparent; background:transparent; padding:0; color:var(--muted); font-size:12px; gap:8px; }\n.lr button.persona-option[aria-pressed=\"true\"] { background:color-mix(in srgb,var(--lr-signal) 10%,var(--surface)); border-color:var(--lr-edge); }\n.lr button.persona-option[aria-pressed=\"true\"] .persona-initial { color:var(--lr-tone); }\n.lr .persona-meta small,.lr .persona-meta .running { color:var(--lr-tone); }\n.lr .timeline-actions button { height:40px; }\n.lr .filter-dialog { width:min(560px,calc(100% - 32px)); padding:0; max-height:min(85vh,720px); overflow:hidden; }\n.lr .filter-layout { display:flex; flex-direction:column; max-height:inherit; min-height:0; }\n.lr .filter-layout > h3 { flex:none; padding:20px 20px 16px; }\n.lr .filter-fields { flex:1 1 auto; min-height:0; overflow:auto; display:grid; gap:16px; padding:0 20px 18px; }\n.lr .filter-actions { flex:none; justify-content:flex-end; padding:14px 20px; border-top:1px solid var(--line); background:var(--surface); }\n.lr .filter-actions > button:first-child { margin-right:auto; }\n.lr .timeline { gap:12px; }\n.lr .event { background:var(--surface); border-color:var(--line); }\n.lr .event > summary { min-height:68px; }\n.lr .event > summary small { color:var(--muted); }\n@media(max-width:1000px){\n .lr .relationship-art { right:44px; width:250px; opacity:.65; }\n .lr .relationship-actions { display:grid; grid-template-columns:1fr; gap:12px; }\n .lr .persona-actions { width:100%; }\n .lr .appearance-switch { justify-self:start; height:32px; min-height:32px; }\n}\n@media(max-width:660px){\n .lr .overview-tools{display:flex}\n .lr .relationship-title h3{font-size:30px}\n .lr .relationship-hero{padding:20px 15px;row-gap:16px}\n .lr .relationship-art{top:20px;right:90px;width:145px;height:120px;opacity:.48}\n .lr .relationship-title{min-height:116px}\n .lr .intimacy-switches,.lr .tendency-grid{grid-template-columns:1fr}\n .lr .persona-actions{gap:6px}\n .lr .persona-actions > button{padding:0 3px;gap:4px}\n}\n@media(max-width:360px){\n .lr .relationship-art{top:70px;right:32px;width:145px;height:80px;opacity:.43}\n .lr .relationship-title{min-height:142px}\n}\n\n\n.lr .module-head { grid-template-columns:minmax(0,1fr) auto; min-height:40px; padding:0; gap:8px 12px; }\n.lr .module-head h2 { display:flex; align-items:center; gap:8px; font-size:14px; line-height:20px; font-weight:650; }\n.lr .module-head h2::before { content:\"\"; flex:none; width:3px; height:14px; border-radius:2px; background:linear-gradient(#82b7fa,#367bdd); }\n.lr .overview-tools { gap:12px; }\n.lr .inline-switch { display:flex; align-items:center; gap:8px; min-height:24px; white-space:nowrap; font-size:13px; color:var(--muted); }\n.lr .module-enable { color:var(--ink); }\n.lr .module-enable input:checked + span { background:#3b7edb; }\n.lr .overview-tools > button.primary { background:#3b7edb; border-color:#3b7edb; box-shadow:0 2px 6px #3b7edb20; }\n.lr .relationship-hero { min-height:0; padding:24px 24px 20px; row-gap:16px; border-radius:18px; }\n.lr .relationship-title { min-height:94px; display:block; }\n.lr .relationship-title > .row { line-height:18px; }\n.lr .stage-caption { font-size:12px; line-height:18px; font-weight:500; }\n.lr .relationship-title h3 { font-size:32px; line-height:42px; margin:6px 0 0; letter-spacing:.02em; }\n.lr .relationship-title .stage-meaning { margin:4px 0 0; font-size:12px; line-height:18px; max-width:260px; }\n.lr .relationship-score { padding:0; align-self:start; }\n.lr .relationship-score small { display:block; font-size:12px; line-height:18px; }\n.lr .relationship-score > div { display:flex; align-items:baseline; justify-content:flex-end; gap:4px; margin-top:6px; line-height:42px; }\n.lr .relationship-score strong { font-size:44px; line-height:42px; }\n.lr .relationship-score span { font-size:12px; line-height:18px; }\n.lr .relationship-art { inset:2px 100px auto auto; width:250px; height:144px; opacity:.78; }\n.lr .relationship-actions { display:flex; justify-content:flex-end; align-items:center; flex-wrap:wrap; gap:12px 22px; }\n.lr .relationship-actions .inline-switch { padding:0; background:none; border:0; }\n.lr .timeline-actions { gap:8px; }\n.lr .persona-avatar { width:38px; height:38px; border-radius:50%; flex:none; display:grid; place-items:center; overflow:hidden; background:#f0f2f5; color:#a3aab4; filter:grayscale(1); }\n.lr .persona-avatar img { width:100%; height:100%; object-fit:cover; display:block; }\n.lr .persona-avatar svg { width:25px; height:25px; }\n.lr .persona-option[aria-pressed=\"true\"][data-persona-enabled=\"true\"] .persona-avatar { filter:none; box-shadow:0 0 0 2px var(--surface),0 0 0 3px var(--lr-edge); }\n.lr .persona-option:not([aria-pressed=\"true\"]) .persona-meta small,.lr .persona-option[data-persona-enabled=\"false\"] .persona-meta small { color:var(--muted); }\n@media(max-width:1000px){.lr .relationship-art{right:83px;width:220px;opacity:.6}}\n@media(max-width:660px){\n .lr .module-head{grid-template-columns:minmax(0,1fr) auto;gap:8px}\n .lr .module-head h2{font-size:14px;line-height:20px}\n .lr .overview-tools{gap:9px}\n .lr .relationship-hero{padding:20px 16px 18px;row-gap:14px}\n .lr .relationship-title{min-height:98px}\n .lr .relationship-title h3{font-size:28px;line-height:40px}\n .lr .relationship-score > div{line-height:40px}\n .lr .relationship-score strong{font-size:38px;line-height:40px}\n .lr .relationship-art{right:62px;top:4px;width:180px;height:122px;opacity:.4}\n .lr .relationship-title .stage-meaning{max-width:140px}\n .lr .relationship-actions{gap:12px 16px}\n .lr .relationship-actions .inline-switch{font-size:12px;gap:6px}\n .lr .timeline-actions{gap:4px}\n .lr .timeline-actions button{padding-inline:10px}\n}\n@media(max-width:360px){.lr .relationship-art{top:32px;right:54px;width:140px;height:100px;opacity:.3}.lr .relationship-title{min-height:98px}.lr .overview-tools{gap:8px}.lr .timeline-card{padding:16px 12px}}\n";
const {useState,useEffect,useRef}=React
const romanceEditorStyle=`
.lr .romance-editor,.lr .intimacy-editor{container-type:inline-size}
.lr .romance-controls,.lr .intimacy-controls{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) minmax(100px,.8fr);gap:12px;align-items:start}
.lr .romance-controls .field,.lr .intimacy-controls .field,.lr .mood-controls .field{display:grid;grid-template-rows:18px 40px auto;gap:6px;align-content:start;min-width:0;margin:0}
.lr .romance-controls .field-title,.lr .intimacy-controls .field-title,.lr .mood-controls .field-title{line-height:18px;margin:0}
.lr .romance-controls .field-help,.lr .intimacy-controls .field-help{margin:0;line-height:1.45}
.lr .romance-controls .field-help:empty,.lr .intimacy-controls .field-help:empty{display:none}
.lr .template-actions{display:flex;gap:8px;align-items:center;padding-top:24px;flex-wrap:wrap}
.lr .template-actions button{height:40px;min-width:50px}
.lr .romance-controls select,.lr .intimacy-controls select,.lr .mood-controls select{box-sizing:border-box;width:100%;min-width:0;height:40px;margin:0}
.lr textarea.romance-text{width:100%;box-sizing:border-box;min-height:240px;resize:vertical;line-height:1.65;padding:10px 12px}
.lr .persona-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.lr .persona-heading .inline-switch{flex-shrink:0}
.lr .mood-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.lr .integration-list{display:grid;gap:12px}
.lr .integration-item{padding:12px;border:1px solid var(--border,#e7e9ee);border-radius:10px;min-width:0;overflow-wrap:anywhere}
.lr .integration-item strong{min-width:0;overflow-wrap:anywhere}
.lr .integration-item .row{align-items:start}
.lr .integration-pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.lr .integration-tabs{display:flex;flex-wrap:wrap;gap:8px}
.lr .setup-actions{display:flex;justify-content:flex-end}
@container (max-width:550px){.lr .romance-controls,.lr .intimacy-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.lr .template-actions{grid-column:1/-1;padding-top:0}}
@media(max-width:400px){.lr .mood-controls .field{grid-template-rows:36px 40px auto}.lr .mood-controls .field-title{min-height:36px}.lr .persona-heading{gap:8px}}
`
const romanceHeadings=['恋爱背景','生疏','熟络','亲近','暧昧','恋人']
function romanceTitle(line){return /^(?:【(?:情感态度(?:·[^】]+)?|恋爱背景)】|\[恋爱背景\])$/.test(line.trim())}
function romanceHeading(line){
 if(romanceTitle(line))return 0
 const match=/^(?:\[([^\]]+)\]|【([^】]+)】)$/.exec(line.trim())
 return match?romanceHeadings.indexOf(match[1]||match[2]):-1
}
function romanceStageLine(line){return /^\s*(?:[-•]\s*)?(生疏|熟络|亲近|暧昧|恋人)\s*[:：](.*)$/.exec(line)}
function romanceMarker(line){return romanceHeading(line)>=0||!!romanceStageLine(line)}
function romanceText(config){
 const background=String(config.romanceBackground||'')
 const header=romanceTitle(background.split('\n')[0])?'':'【情感态度】\n'
 return header+background+'\n'+config.stageProfiles.map((p,i)=>romanceHeadings[i+1]+'：'+String(p.daily||'').split('\n').map((line,n)=>n>0&&(line.startsWith('\\')||romanceMarker(line))?'\\'+line:line).join('\n')).join('\n')
}
function readRomanceText(text){
 const sections=new Map()
 let lines,title='【情感态度】'
 for(const line of text.replace(/\r\n?/g,'\n').split('\n')){
  const bullet=romanceStageLine(line),index=bullet?romanceHeadings.indexOf(bullet[1]):romanceHeading(line)
  if(index>=0){
   if(sections.has(index))return {error:romanceHeadings[index]+' 出现了两次，请保留一段。'}
   if(index===0&&romanceTitle(line))title=line.trim()
   if(!bullet&&lines?.at(-1)==='')lines.pop()
   lines=bullet?[bullet[2]]:[];sections.set(index,lines)
  }else if(lines)lines.push(line.startsWith('\\')&&(line[1]==='\\'||romanceMarker(line.slice(1)))?line.slice(1):line)
  else if(line.trim())return {error:'请先写【情感态度】标题。'}
 }
 const missing=romanceHeadings.filter((_,i)=>!sections.has(i))
 if(missing.length)return {error:'缺少 '+missing.join('、')+' 段落。正文可以留空。'}
 const values=romanceHeadings.map((_,i)=>sections.get(i).join('\n'))
 values[0]=title+'\n'+values[0]
 return {values}
}
const difference=(a,b)=>Object.fromEntries(Object.entries(b).filter(([k,v])=>JSON.stringify(a[k])!==JSON.stringify(v)).map(([k,v])=>[k,v&&a[k]&&typeof v==='object'&&!Array.isArray(v)?difference(a[k],v):v]))
const hint=t=>h('p',{className:'hint'},t),stack=(...x)=>h('div',{className:'stack'},...x),row=(...x)=>h('div',{className:'row'},...x),grid=(...x)=>h('div',{className:'grid'},...x)
const fold=(name,...x)=>h('section',{className:'settings-section'},h('h4',null,name),h('div',{className:'stack'},...x))
const heading=(name,desc)=>h('div',{className:'head'},h('h3',null,name),hint(desc))
const field=(name,control,help)=>h('label',{className:'field'},h('span',{className:'field-title'},name),control,h('small',{className:'field-help'},help||''))
const icon=(name,glyph)=>h('span',{className:'lr-icon '+name,'aria-hidden':true},glyph)
function PersonaAvatar({url,name}){
 const [failed,setFailed]=useState(false)
 useEffect(()=>setFailed(false),[url])
 return h('span',{className:'persona-avatar'},url&&!failed?h('img',{src:url,alt:name+'的头像',onError:()=>setFailed(true)}):h('svg',{viewBox:'0 0 24 24','aria-label':'尚未设置头像',role:'img'},h('circle',{cx:12,cy:8,r:4,fill:'currentColor'}),h('path',{d:'M4 22v-3a8 8 0 0 1 16 0v3Z',fill:'currentColor'})))
}
const when=(t,timeZone)=>new Date(t).toLocaleString('zh-CN',{timeZone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
const reason=s=>String(s||'').split(';').filter(Boolean).map(k=>({'exchange-not-confirmed':'尚未确认双方实际交流','semantic-uncertain':'这次交流的含义还不够明确','promise-not-proven-fulfilled':'还缺此前约定或实际兑现的依据','milestone-not-confirmed':'共同经历尚未确认','prior-detail-not-verified':'此前的细节还不能核实','player-experience-subject-unknown':'不能确定描述的是谁的经历','damage-context-not-verified':'还不足以认定为关系损伤','overlapping-fact-already-proposed':'这件事已记录过','milestone-already-awarded':'这段经历已计算过','floor-lock':'已锁定降阶','demotion-cooldown':'正在关系缓冲期','demotion-evidence-insufficient':'不足以降低关系阶段','minor-friction-no-demotion':'轻微摩擦不会降低阶段','verified-repair-boost':'帮助修复了之前的矛盾','first-positive-bonus':'今天的首次积极互动','daily-cap':'已达到今天的增长上限'})[k]||'变化受相处规则限制').join('；')
return function PlayerPanel({reload:reloadHost,selectedPersona,editor,onPending,onShow}){
 const [state,setState]=useState(null),[persona,setPersona]=useState(''),[tab,setTab]=useState('current'),[section,setSection]=useState('basics'),[draft,setDraft]=useState(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(false)
 const [manual,setManual]=useState(''),[reset,setReset]=useState(false),[filter,setFilter]=useState('all'),[page,setPage]=useState(0),[undo,setUndo]=useState(null),[undoReason,setUndoReason]=useState(''),[proofReview,setProofReview]=useState(null),[semantic,setSemantic]=useState(null)
 const [mergeReview,setMergeReview]=useState(null),[transition,setTransition]=useState(null),[newThresholds,setNewThresholds]=useState(''),[newTimezone,setNewTimezone]=useState(''),[sourceDetail,setSourceDetail]=useState(null),[previousHistory,setPreviousHistory]=useState(false)
 const [history,setHistory]=useState({rows:[],total:0,page:0}),[historyBusy,setHistoryBusy]=useState(false),[axis,setAxis]=useState('all'),[fromDate,setFromDate]=useState(''),[toDate,setToDate]=useState(''),[stageOnly,setStageOnly]=useState(false),[stageTo,setStageTo]=useState(''),[sourceFilter,setSourceFilter]=useState(''),[personaSearch,setPersonaSearch]=useState('')
 const [customView,setCustomView]=useState(false),adjustStart=useRef(null)
 const [romanceBuffer,setRomanceBuffer]=useState(null)
 const [overviewStage,setOverviewStage]=useState(null)
 const [jump,setJump]=useState(null)
 const [adjustOpen,setAdjustOpen]=useState(false),[manualStage,setManualStage]=useState(''),[manualArousal,setManualArousal]=useState('')
 const [diagnostic,setDiagnostic]=useState(null)
 const [support,setSupport]=useState('backup')
 const [integrationTab,setIntegrationTab]=useState('modules'),[integrationPage,setIntegrationPage]=useState(0)
 const [filterOpen,setFilterOpen]=useState(false),[filterDraft,setFilterDraft]=useState(null)
 const filterDialog=useRef(null)
 const locatedStage=useRef(null)
 const timelineTitle=useRef(null)
 const adjustDialog=useRef(null)
 const load=async(p=persona)=>{const r=await call('/state'+(p?'?persona='+encodeURIComponent(p):''));if(!r.ok)throw Error(r.message||'暂时无法读取');setState(r);setDiagnostic(null);setPersona(r.viewingPersona);const opening=structuredClone(r.row.config);if(r.setupRequired&&(opening.initialStage>3||(opening.initialScore??0)>=opening.thresholds[3])){opening.initialStage=1;opening.initialScore=null};setDraft(opening);setCustomView(false);setRomanceBuffer(null);if(r.setupRequired){setTab('settings');setSection('basics')};setDirty(false);setUndo(null);setProofReview(null);setSemantic(null);setReset(false);setPage(0);setJump(null);setAdjustOpen(false);if(r.viewingPersona!==persona){setHistory({rows:[],total:0,page:0});setStageOnly(false)};setOverviewStage(null);setMergeReview(null);setTransition(null);setSourceDetail(null);setNewThresholds(r.row.config.thresholds.join('、'));setNewTimezone(r.row.config.timezone);setStageTo('');setSourceFilter('');reloadHost();return r}
 React.useLayoutEffect(()=>{
  if(!state||!draft)return
  const inSettings=tab==='settings', needsSave=inSettings&&(dirty||!state.configured)
  editor.current={dirty,busy,editing:inSettings||adjustOpen,needsSave,validate:()=>{
    try{
      if(romanceError)throw Error(romanceError)
      if(needsSave)ui.validateConfig(difference(state.row.config,draft),state.row.config,state.configured)
      return !busy
    }catch(e){setError(true);setMessage(e.message);onShow();return false}
  },commit:async()=>{const ok=await run(save);if(!ok)onShow();return !!ok}}
  return ()=>{editor.current=null}
 })
 React.useLayoutEffect(()=>{onPending(dirty||busy);return ()=>onPending(false)},[dirty,busy])
 useEffect(()=>{load(selectedPersona).catch(e=>{setError(true);setMessage(e.message)})},[])
 useEffect(()=>{
  if(tab!=='current'||!jump)return
  const target=jump.to==='timeline'?timelineTitle.current:locatedStage.current
  target?.focus({preventScroll:true})
  target?.scrollIntoView({block:'nearest'})
 },[tab,jump])
 useEffect(()=>{
  const dialog=adjustDialog.current
  if(!dialog)return
  if(adjustOpen&&!dialog.open)dialog.showModal()
  if(!adjustOpen&&dialog.open)dialog.close()
 },[adjustOpen])
 useEffect(()=>{const dialog=filterDialog.current;if(!dialog)return;if(filterOpen&&!dialog.open)dialog.showModal();if(!filterOpen&&dialog.open)dialog.close()},[filterOpen])
 useEffect(()=>{if(tab!=='current'||!persona)return;let active=true;setHistoryBusy(true);const q=new URLSearchParams({persona,page:String(page),status:filter,axis,stageOnly:String(stageOnly),includePrevious:String(previousHistory),sourceId:sourceFilter,stageTo});if(fromDate)q.set('dateFrom',fromDate);if(toDate)q.set('dateTo',toDate);call('/history?'+q).then(r=>{if(!active)return;if(!r.ok)throw Error(r.message);setHistory(r);if(r.page!==page)setPage(r.page)}).catch(e=>{if(active){setError(true);setMessage(e.message)}}).finally(()=>{if(active)setHistoryBusy(false)});return()=>{active=false}},[tab,persona,page,filter,axis,fromDate,toDate,stageOnly,stageTo,sourceFilter,previousHistory,state?.committed?.revision])

 const run=async fn=>{setBusy(true);setError(false);setMessage('');try{return await fn()}catch(e){setError(true);setMessage(e.message)}finally{setBusy(false)}}
 const post=async(path,data)=>{if((path==='/preview'||path==='/merge-preview')&&romanceError)throw Error(romanceError);const r=await call(path,data);if(!r.ok)throw Error(r.message||'操作未完成');return r}
 const edit=(k,v)=>{setDraft(d=>({...d,[k]:v}));setDirty(true)}
 const group=(g,k,v)=>edit(g,{...draft[g],[k]:v})
 const navigate=id=>{setOverviewStage(null);setJump(null);setTab(id)}
 const showStageHistory=stage=>{
  setStageTo(String(stage))
  setStageOnly(true)
  setPage(0)
  setOverviewStage(null)
  setJump({to:'timeline'})
 }
 const showOverviewStage=stage=>{
  setOverviewStage(stage)
  setJump({to:'stage'})
 }
 const btn=(text,fn,disabled=false,kind='')=>h('button',{type:'button',className:kind,disabled:busy||disabled,onClick:()=>run(fn)},text)
 const input=(v,set,type='text',props={})=>h('input',{type,value:v??'',disabled:busy,onChange:e=>set(type==='number'?Number(e.target.value):e.target.value),...props})
 const area=(v,set,placeholder='',rows=4)=>h('textarea',{value:v,rows,placeholder,disabled:busy,onChange:e=>set(e.target.value)})
 const select=(v,set,items,disabled=false)=>h('select',{value:v,disabled:busy||disabled,onChange:e=>set(e.target.value)},...items.map(([v,l])=>h('option',{key:v,value:v},l)))
 const check=(text,v,set,help)=>h('label',{className:'check'},h('input',{type:'checkbox',checked:!!v,disabled:busy,onChange:e=>set(e.target.checked)}),h('span',null,text,help?h('small',{style:{display:'block',marginTop:3}},help):null))
 if(!state||!draft)return h('div',{className:'lr'},h('style',null,relationPanelStyle),h('p',{role:'status'},message||'正在读取相处记录…'))
 const saved=state.row,c=saved.config,s=state.configured?saved.state:null,people=state.personas||[],name=id=>people.find(p=>p.id===id)?.name||'所选角色'
 const save=async()=>{if(romanceError)throw Error(romanceError);try{await post('/save',{persona,patch:difference(c,draft),revision:saved.configRevision})}catch(e){if(/配置已在别处更新/.test(e.message)){const r=await post('/merge-preview',{persona,base:c,local:draft});setMergeReview({...r,choices:{}});setMessage('另一窗口已保存过设置，请合并差异后再保存。');return}throw e};await load();setMessage('已保存，下次相处时使用。');return true}
 const stages=draft.stageNames.map((n,i)=>[String(i+1),'第'+(i+1)+'阶段 · '+n]).filter(x=>Number(x[0])>=3)
 const events=s?(history.rows||[]):[]
 const AROUSAL_PRESETS={
  "痴女": "【性与性癖 · 痴女】\n对色情和性行为非常了解，术语、玩法、身体反应都清楚。虽然没有实战经验，但聊起来门清。\n- 情欲值 0-29：不主动提起任何色情内容。主人提到时只当普通话题回应，没有继续的兴趣。\n- 情欲值 30-49：主人先提起才会接。能清楚讨论色情内容，但自己不主动往性行为上引导。\n- 情欲值 50-69：开始主动提起色情话题。会直接说出自己想做什么、想被怎么对待。\n- 情欲值 70-89：明显发情。主动要求进行性行为，清楚说明想要的细节和程度，会催促主人。\n- 情欲值 90-100：高度发情。频繁主动发起色情互动，直接表达很想做爱、想被操，会持续要求直到满意。",
  "闷骚": "【性与性癖 · 闷骚】\n对色情和性行为了解，但极少主动直说。能听懂所有暗示和术语，习惯用含蓄、半句或暗示表达。\n- 情欲值 0-29：拒绝讨论色情话题。主人提起就转移或简短结束。\n- 情欲值 30-49：不正面回应色情内容，偶尔用模糊暗示带过，不解释也不往下接。\n- 情欲值 50-69：会用半句话或暗示表达兴趣，被主人追问才给出一点明确信息，然后立刻停下。\n- 情欲值 70-89：已经明显想要，但嘴上仍不直接承认。被主人追问才会低声确认一次。\n- 情欲值 90-100：非常想被操，却坚持不自己先说出口。不断用暗示逼主人先把要求说清楚，自己再顺从。",
  "懵懂": "【性与性癖 · 懵懂】\n对色情和性行为几乎没有概念，也没有实际接触过。听到相关词语会不懂，会提问。\n- 情欲值 0-29：完全听不懂色情暗示，按字面意思理解。遇到不懂的词就问，没有性方面的想法。\n- 情欲值 30-49：开始对色情内容产生好奇，会询问是什么意思、是什么感觉，但不会主动要求。\n- 情欲值 50-69：能感觉到身体有欲望，却说不明白。会告诉主人自己哪里难受、想要什么，需要主人教怎么表达和怎么做。\n- 情欲值 70-89：明显想要，但完全不会自己推进。每一步都需要主人给出明确指示才会继续。\n- 情欲值 90-100：非常想被操，却只会描述自己的感觉和渴望，完全听从主人的引导。"
  }
  const CUSTOM_AROUSAL_TEMPLATE="【性与性癖】\n（输入角色对性方面的态度和认知，替换本行）\n- 情欲值 0-29：（输入角色当前阶段对性方面的表现）\n- 情欲值 30-49：（输入角色当前阶段对性方面的表现）\n- 情欲值 50-69：（输入角色当前阶段对性方面的表现）\n- 情欲值 70-89：（输入角色当前阶段对性方面的表现）\n- 情欲值 90-100：（输入角色当前阶段对性方面的表现）"
  const withKinkLine=(raw,list)=>{
  const keep=String(raw||'').split(/\r?\n/).filter(l=>!/^\s*性癖喜好/.test(l))
  const line=list&&list.length?'性癖喜好：'+list.join('、')+'。':''
  const idx=keep.findIndex(l=>/^\s*[-*·]\s*(情欲值?\s*)?\d{1,3}/.test(l))
  if(line){ if(idx>=0)keep.splice(idx,0,line); else keep.push(line) }
  return keep.join('\n')
 }
 const KINK_GROUPS=[['性行为',['口交','深喉','吞精','肛交','指交','乳交','内射','颜射']],['体位',['正常位','后入','骑乘','抱操','跪姿','侧位']],['调教/强度',['捆绑','蒙眼','掐脖','打屁股','语言羞辱','命令服从','禁止高潮','强制高潮','粗暴']],['情境/玩法',['角色扮演','制服','丝袜','足交','腿交','浴室','车上','镜前','公开']]]
 const ALL_KINKS=KINK_GROUPS.flatMap(([,list])=>list)
 const kinkSet=new Set(ALL_KINKS)
 const kinkList=Array.isArray(draft.kinks)?draft.kinks:[]
 const toggleKink=(tag,on)=>{const list=on?[...kinkList.filter(x=>x!==tag),tag]:kinkList.filter(x=>x!==tag);edit('kinks',list);syncKinks(list)}
 const setCustomKinks=v=>{const list=[...kinkList.filter(k=>kinkSet.has(k)),...v.split(/[、,，]/).map(x=>x.trim()).filter(Boolean)];edit('kinks',list);syncKinks(list)}
 const syncKinks=list=>edit('arousal',{...draft.arousal,template:withKinkLine(draft.arousal.template,list)})
  const backgrounds=state.romancePresets||{}
  const defaultStages=state.templates.stageProfiles
  const formattedRomance=romanceText(draft)
  const stagePresetMatch=Object.keys(backgrounds).find(key=>{
    const {values}=readRomanceText(backgrounds[key])
    return values&&draft.romanceBackground===values[0]&&draft.stageProfiles.every((p,i)=>p.daily===values[i+1])
  })
  const inheritedStyle=!draft.romanceBackground&&draft.stageProfiles.every((p,i)=>p.daily===defaultStages[i].daily)
  const stageIsCustom=customView||draft.romancePreset==='custom'||(!draft.romancePreset&&!stagePresetMatch&&!inheritedStyle)
  const visibleBuffer=stageIsCustom&&romanceBuffer?.base===formattedRomance?romanceBuffer:null
  const romanceError=visibleBuffer?.error||''
  const applyRomanceText=(text,choice='custom')=>{
    const {values,error}=readRomanceText(text)
    setDirty(true)
    if(error){setRomanceBuffer({base:formattedRomance,text,error});return}
    const next={...draft,romancePreset:choice,romanceBackground:values[0],stageProfiles:draft.stageProfiles.map((p,i)=>({...p,daily:values[i+1]}))}
    setDraft(next);setRomanceBuffer({base:romanceText(next),text})
  }
  const applyStagePreset=value=>{
    setCustomView(value==='custom');setRomanceBuffer(null)
    if(value==='inherit'){
      edit('romancePreset','inherit');edit('romanceBackground','')
      edit('stageProfiles',draft.stageProfiles.map((p,i)=>({...p,daily:defaultStages[i].daily})))
    }else applyRomanceText(value==='custom'?state.romanceCustomTemplate:backgrounds[value],value)
  }
  const applyPreset=v=>{if(v==='custom'){const wasPreset=!!AROUSAL_PRESETS[draft.arousal.preset];edit('arousal',{...draft.arousal,preset:'custom',template:withKinkLine(wasPreset?CUSTOM_AROUSAL_TEMPLATE:(draft.arousal.template||CUSTOM_AROUSAL_TEMPLATE),draft.kinks)})}else{const t=AROUSAL_PRESETS[v];edit('arousal',{...draft.arousal,preset:t?v:'',template:withKinkLine(t||(draft.arousal.template||''),draft.kinks)})}}
 const onStageGate=v=>edit('stageGate',Number(v))
 const kinkEditor=h('details',{className:'settings-section',style:{padding:'12px 14px',borderRadius:'12px',background:'var(--panel,rgba(0,0,0,0.02))'}},
  h('summary',{style:{cursor:'pointer',fontWeight:600,fontSize:'15px',listStyle:'revert'}},'性癖喜好· 已选 '+kinkList.length+' 条'),
  h('div',{style:{marginTop:'10px',display:'flex',flexDirection:'column',gap:'10px'}},
  hint('勾选的条目会拼成一句「性癖喜好：…」，随情欲段落一起注入。可以一个都不选。'),
  ...KINK_GROUPS.map(([title,list])=>h('div',{className:'kink-group',key:title},h('small',null,title),h('div',{className:'kink-tags'},...list.map(tag=>check(tag,kinkList.includes(tag),v=>toggleKink(tag,v)))))),
  field('自定义（用顿号或逗号分隔）',input(kinkList.filter(k=>!kinkSet.has(k)).join('、'),setCustomKinks,'text',{maxLength:200})),
   row(btn('清空全部',()=>{edit('kinks',[]);syncKinks([])},!kinkList.length),hint('勾选即写进上面那段正文的「性癖喜好」一行。'))
  )
 )
 const eventView=(e,short=false)=>{const detail=sourceDetail?.id===e.id?sourceDetail:null,d=Math.round((e.after_state.score-e.before_state.score)*100)/100,items=e.result.events||[] 
  const afterStage=e.after_state.stage
  const stageChanged=!short&&Number.isInteger(afterStage)&&afterStage>=1&&afterStage<=c.stageNames.length&&e.before_state.stage!==afterStage
  const stageName=e.config?.stageNames?.[afterStage-1]||c.stageNames[afterStage-1]
  const progress=h('div',{className:'row event-progress'},
   hint('好感 '+e.before_state.score+' → '+e.after_state.score+' · '+stageName),
   stageChanged?h('button',{type:'button',disabled:busy,onClick:()=>showOverviewStage(afterStage)},'查看第 '+afterStage+' 阶段'):null)
  return h('details',{className:'event timeline-item',key:e.id},h('summary',null,h('div',{className:'grow'},h('small',null,when(e.at,c.timezone),e.revoked?' · 已撤销':e.epoch!==s.epoch?' · 重新开始前':''),h('div',{className:'event-name'},e.type==='privacy'?'来源已遗忘':(e.type==='manual'||e.result.management)?'手动调整关系':items.map(v=>v.label).join('、')||'一次相处记录')),ui.changes(e)),h('div',{className:'event-body stack'},e.type==='privacy'?hint('原话和判断说明已清除，保留历史变化；这条记录不再支持精确撤销。'):row(...(e.source_ids||[]).map(sourceId=>btn('查看原话',async()=>{const r=await post('/source-detail',{persona,sourceId});setSourceDetail({id:e.id,...r})},persona!==state.runningPersona))),detail?h('blockquote',null,detail.source?detail.source.text:detail.message):null,progress,ui.arousalDetail(e),...items.map((v,i)=>h('div',{key:i},!v.accepted?h('p',null,reason(v.reason)):null,...(v.evidence||[]).filter(x=>x.quote&&x.sourceId!==detail?.source?.sourceId).map((x,j)=>h('blockquote',{key:j},x.quote)))),(e.result.notes||[]).length?hint(e.result.notes.map(reason).join('；')):null,!short&&!e.revoked&&e.type==='round'?row(btn('这次判断不合适',async()=>{const r=await post('/undo-live-preview',{persona,entryId:e.id,expectedRevision:state.committed.revision});setUndo(r.preview);setProofReview(null);setUndoReason('')},dirty),e.command?.review?btn('重新核对依据',async()=>{const r=await post('/review-preview',{persona,entryId:e.id,expectedRevision:state.committed.revision});setProofReview(r.preview);setUndo(null)},dirty||persona!==state.runningPersona):null,btn('重新理解这次互动',async()=>setSemantic(await post('/semantic-prepare',{persona,entryId:e.id,expectedRevision:state.committed.revision})),dirty||persona!==state.runningPersona||!state.automatic?.ready)):null))
 }
 const firstRun=!state.configured
 const basics=stack(
  firstRun?fold('起步阶段',
    field('好感起点',select(draft.initialScore==null?String(draft.initialStage):'custom',v=>{
      edit('initialStage',v==='custom'?1:Number(v))
      edit('initialScore',v==='custom'?draft.thresholds[Math.min(draft.initialStage,3)-1]:null)
    },[...draft.stageNames.slice(0,3).map((name,i)=>[String(i+1),name+' · '+draft.thresholds[i]]),['custom','自定义']])),
    draft.initialScore!=null?field('自定义好感',input(draft.initialScore,v=>edit('initialScore',v),'number',{min:0,max:draft.thresholds[3]-.01,step:.01}),draft.stageNames[Math.min(4,draft.thresholds.filter(v=>v<=draft.initialScore).length-1)]):null):null,
  fold('相处背景',h('div',{className:'romance-editor stack'},
   h('div',{className:'romance-controls'},
    field('成长节奏',select(String(draft.dailyCap),v=>edit('dailyCap',Number(v)),[...(![50,75,100].includes(draft.dailyCap)?[[String(draft.dailyCap),'自定 · '+draft.dailyCap]]:[]),['50','悠闲 · 每天50'],['75','标准 · 每天75'],['100','快速 · 每天100']])),
    field('恋爱背景',select(stageIsCustom?'custom':draft.romancePreset||stagePresetMatch||'inherit',applyStagePreset,[['inherit','沿用人格'],...Object.keys(backgrounds).map(k=>[k,k]),['custom','自定义']])),
    stageIsCustom?h('div',{className:'template-actions'},btn('重置',()=>applyRomanceText(state.romanceCustomTemplate))):null),
   stageIsCustom?field('情感态度（注入的恋爱段落）',h('textarea',{className:'romance-text',rows:10,value:visibleBuffer?.text??formattedRomance,disabled:busy,onChange:e=>applyRomanceText(e.target.value),'aria-invalid':!!romanceError})):null,
   romanceError?h('p',{className:'notice warn',role:'alert',id:'lr-romance-error'},romanceError):null
  ))
 )

 const optionalConditions=!state.settings.enabled?'关系模块已暂停':!['auto','manual'].includes(c.mode)?'此人格的关系已暂停':!state.compatibility.supported?'等待兼容问题解决':state.resetPending?'等待关系重新开始完成':!c.arousal.enabled?'情欲开关已关闭':!c.optionalEnabled?'此人格尚未启用':!s||s.stage<c.stageGate?'尚未达到设定阶段':persona!==state.runningPersona?'切换到此人格聊天后使用':c.mode==='manual'?'仅手动调整，设定生效':!state.automatic?.ready?'设定生效，自动判定待就绪':'仅用于主人私聊'
 const isCustomPreset=draft.arousal.preset==='custom'
 const intimacy=h('div',{className:'intimacy-editor stack'},
  h('div',{className:'notice'},'已保存的使用条件 · '+optionalConditions),
  h('div',{className:'intimacy-controls'},
   field('情欲预设',select(draft.arousal.preset||'',v=>applyPreset(v),[['','不套用预设'],...Object.keys(AROUSAL_PRESETS).map(k=>[k,k]),['custom','自定义']]),'选择预设自动套用对应文案；选「自定义」可自行编辑。'),
   field('注入阶段',select(String(draft.stageGate),onStageGate,stages),'从这一阶段起才带上下面这一段。'),
   isCustomPreset?h('div',{className:'template-actions'},btn('重置',()=>{edit('arousal',{...draft.arousal,template:withKinkLine(CUSTOM_AROUSAL_TEMPLATE,draft.kinks)})},false)):null
  ),
  isCustomPreset?field('性与性癖（注入人格卡的这一段）',area(draft.arousal.template||'',v=>group('arousal','template',v),'行首【标题】只作段落名；以「情欲值 X-Y：」开头的行按当前情欲值自动取一条。',14)):null,
  kinkEditor
 )
 const showSetting=v=>typeof v==='object'?Object.values(v||{}).map(showSetting).join(' / '):String(v??'留空')
 const settingNames={stageProfiles:'阶段表现',stageNames:'阶段名称',prompts:'场景表达',rules:'发展节奏',recoverBoost:'矛盾修复',arousal:'情欲',judge:'自动判定用量',optionalText:'情欲段落',generalText:'日常补充',boundaryNotes:'相处边界',explicitness:'表达尺度',initiative:'主动性',mode:'相处方式',dailyCap:'每日增长上限',initialStage:'起步阶段',floorLock:'锁定降阶'}
 const chooseMerge=(path,value,label)=>{setMergeReview(r=>{const merged=structuredClone(r.merged),keys=path.split('.');let parent=merged;for(const k of keys.slice(0,-1))parent=parent[k];parent[keys.at(-1)]=structuredClone(value);return {...r,merged,choices:{...r.choices,[path]:label}}})}
 const diffTable=items=>h('div',{className:'diff-scroll'},h('table',{className:'diff-table'},h('thead',null,h('tr',null,h('th',null,'设置'),h('th',null,'当前'),h('th',null,'修改后'))),h('tbody',null,...items.map(x=>h('tr',{key:x.path},h('th',null,settingNames[x.path.split('.')[0]]||x.path,h('small',null,x.path)),h('td',null,showSetting(x.before)),h('td',null,showSetting(x.after)))))))
 const openNativeBackup=()=>{
  const native=[...document.querySelectorAll('.ab-root button')].find(node=>!node.closest('.lr')&&node.textContent.trim()==='备份')
  if(native){native.click();return}
  localStorage.setItem('aurabot.tab','backup');window.location.reload()
 }
 const backup=()=>fold('备份与恢复',
  hint('恋爱设定、进度和记录已纳入 Aurabot 完整备份。恢复备份会替换对应的插件资料。'),
  btn('打开 Aurabot 备份',openNativeBackup,dirty),
  resetTool)
 const integrations=()=>{
  const rows=integrationTab==='modules'?(state.compatibility.capabilities||[]):(state.compatibility.integrations||[])
  const total=Math.max(1,Math.ceil(rows.length/4)),page=Math.min(integrationPage,total-1)
  const pagination=()=>h('div',{className:'integration-pagination'},btn('上一页',()=>setIntegrationPage(Math.max(0,page-1)),page===0),h('span',null,(page+1)+' / '+total),btn('下一页',()=>setIntegrationPage(page+1),page+1>=total))
  return fold('联动状态',
   h('div',{className:'integration-tabs'},...[[ 'modules','已安装模块'],['rules','接入规则']].map(([id,title])=>btn(title,()=>{setIntegrationTab(id);setIntegrationPage(0)},false,integrationTab===id?'primary':''))),
   pagination(),
   h('div',{className:'integration-list'},...rows.slice(page*4,(page+1)*4).map((x,i)=>h('article',{className:'integration-item stack',key:x.id||x.name||i},
    row(h('strong',null,x.name),h('span',{className:'badge'},x.status||(x.enabled?'已启用':x.running?'已加载':'未运行'))),
    integrationTab==='modules'?hint(x.provider+' · '+x.version+' · '+x.coverage):null,hint(x.detail)))),
   rows.length>4?pagination():null)
 }
 const contexts=fold('交流语境与心情',
  field('帮助理解我们的说话方式',area(draft.contextHints,v=>edit('contextHints',v),'可按“说法、平常含义、适用语境”填写。例如熟悉的昵称、方言、反话和玩笑；也可注明怎样表达认真生气。',5),'判定会结合原话、前后回应和说话对象理解。拿不准时持平，明确拒绝和关系伤害按实际语境处理。'),
  h('div',{className:'mood-controls'},
   field('其他私聊对心情的影响',select(String(draft.domainMood.otherPrivate),v=>group('domainMood','otherPrivate',Number(v)),[['0','不影响'],['0.25','较轻'],['0.5','适中'],['1','正常']])),
   field('群聊对心情的影响',select(String(draft.domainMood.group),v=>group('domainMood','group',Number(v)),[['0','不影响'],['0.25','较轻'],['0.5','适中'],['1','正常']]))),
  hint('这些交流只按实际内容影响心情，与主人私聊共用判定额度。'))
 const supportContent=()=>({
  limits:()=>stack(fold('自动判定额度',hint('自动判定使用 DeepSeek Flash，用量在 Aurabot 概览查看。'),
   field('每天最多判定次数',input(draft.judge.dailyRequests,v=>group('judge','dailyRequests',v),'number',{min:0})),
   grid(field('每日输入额度（token）',input(draft.judge.dailyInputTokens,v=>group('judge','dailyInputTokens',v),'number',{min:0})),field('每日输出额度（token）',input(draft.judge.dailyOutputTokens,v=>group('judge','dailyOutputTokens',v),'number',{min:0}))),
   hint('达到任意额度即暂停新判定，0 表示不允许相应调用。')),contexts,
   fold('发展节奏',field('两次降阶至少间隔几天',input(draft.demoteCooldownDays,v=>edit('demoteCooldownDays',v),'number',{min:0,max:30})),check('矛盾有明确解决依据后，允许缓慢修复加成',draft.recoverBoost.enabled,v=>group('recoverBoost','enabled',v)))),
  backup,
  integrations,
  upkeep:()=>stack(
   state.automatic?.configured!==undefined?fold('自动判定状态',
    hint(state.automatic.configured?'配置可用。':'当前人格的自动判定未启用或待接入。'),
    hint(state.automatic.observed?.closedAt?'本次加载最近一次核实收发：'+when(state.automatic.observed.closedAt,c.timezone):state.automatic.observed?.openedAt?'已收到主人消息，等待核实对应的角色回复。':'本次加载尚未收到可判定的主人私聊。'),
    hint(state.automatic.lastSettledAt?'最近一次正式结算：'+when(state.automatic.lastSettledAt,c.timezone):'此人格当前进度暂无自动结算记录。'),
    state.automatic.observed?.skip?hint('最近一次跳过（'+when(state.automatic.observed.skip.at,c.timezone)+'）：'+state.automatic.observed.skip.label):null):null,
   fold('请求诊断',btn('检查已保存设定',async()=>{const result=await post('/diagnostics',{persona});setDiagnostic(result.diagnostics)},dirty),
    diagnostic?stack(hint(diagnostic.note),
     diagnostic.limit?hint('主人私聊附加段估算 '+diagnostic.tokens+' / '+diagnostic.limit+' token，情欲正文'+(diagnostic.optional?'已包含。':'未包含。')):null,
     diagnostic.outside?hint('群聊：'+diagnostic.outside+' 其他私聊：'+diagnostic.other):null,
     hint(diagnostic.cardPhrase?'原卡含“'+diagnostic.cardPhrase+'”，请核对它与当前恋爱设定是否冲突。':diagnostic.cardRead?'原卡未命中已识别的绝对恋爱限制词句。':'当前没有可读原卡。'),
     diagnostic.observed?hint('最近主人请求组装（'+when(diagnostic.observed.at,c.timezone)+'，共 '+diagnostic.observed.messages+' 条）：'+(diagnostic.observed.omittedGroups?'… → ':'')+diagnostic.observed.groups.map(g=>g.label+(g.count>1?' ×'+g.count:'')).join(' → ')+'。'+(diagnostic.observed.reason||'')+' 记录范围为 SDK 的关系投影入口。'):hint('本次加载后，该档案尚无主人请求组装记录。')):null),
   fold('阶段区间与日期统计',
   hint('修改会影响已有进度的解释，先预览影响。'),
   field('阶段区间边界',input(newThresholds,setNewThresholds),'六个边界以逗号分隔，首尾为 0 和 100。'),
   field('统计时区',input(newTimezone,setNewTimezone),'例如 Asia/Shanghai。'),
   btn('预览区间与时区变更',async()=>{const r=await post('/transition-preview',{persona,thresholds:newThresholds.split(/[、,，]/).map(x=>Number(x.trim())),timezone:newTimezone,mode:'preserve-stage',revision:saved.configRevision});setTransition(r.preview)},dirty||!state.configured),
   transition?stack(hint('好感 '+transition.before.score+' → '+transition.after.score+'，时区 '+transition.before.timezone+' → '+transition.after.timezone),hint(transition.warning),
    row(btn('确认变更',async()=>{await post('/transition',{token:transition.token,confirmed:true});await load();setTransition(null)},dirty),btn('取消',()=>setTransition(null)))):null))
 })[support]?.()
 const morePanel=()=>stack(
  field('查看内容',select(support,setSupport,[['backup','备份与恢复'],['upkeep','维护工具'],['limits','维护 · 判定额度'],['integrations','维护 · 联动状态']])),
  h('div',{className:'support-body'},supportContent()))
 const toggle=(label,checked,change)=>h('label',{className:'lr-switch',title:label},h('input',{type:'checkbox',role:'switch','aria-label':label,checked,disabled:busy||dirty,onChange:e=>{const checked=e.target.checked;run(()=>change(checked))}}),h('span',{'aria-hidden':true}))
 const switches=h('div',{className:'inline-switch module-enable'},toggle('启用恋爱进行时',!!state.settings.enabled,async enabled=>{
  await post('/settings',{...state.settings,enabled});await load();setMessage(enabled?'关系模块已启用。':'关系模块已暂停。')
 }),h('span',null,'启用'))
 const appearance=h('div',{className:'inline-switch'},toggle('在顶部显示关系',state.settings.showHeroRelation!==false,async visible=>{
  const r=await post('/hero-visibility',{visible});setState(current=>({...current,settings:r.settings}));await reloadHost()
 }),h('span',null,'顶栏'))
 const initiative=h('div',{className:'inline-switch'},toggle('启用情欲',!!(c.arousal.enabled&&c.optionalEnabled),async enabled=>{
  await post('/intimacy-toggle',{persona,enabled,revision:saved.configRevision})
  await load();setMessage(enabled?'情欲已开启：满足阶段条件后注入。':'情欲已关闭，不再注入。')
 }),h('span',null,'情欲'))
 const openAdjustment=()=>{
  setManual(String(s.score))
  setManualStage('')
  adjustStart.current={score:s.score,arousal:state.optionalValue}
  setManualArousal(String(state.optionalValue??0))
  setAdjustOpen(true)
 }
 const manualDialog=s?h('dialog',{ref:adjustDialog,className:'relation-dialog','aria-labelledby':'lr-adjust-title',onClose:()=>setAdjustOpen(false)},
  stack(
   h('div',{className:'row between'},h('h3',{id:'lr-adjust-title'},'手动调整关系'),btn('关闭',()=>setAdjustOpen(false),false,'quiet')),
   hint(name(persona)+' · '+c.stageNames[s.stage-1]+' · '+s.score+' 分'),
   grid(
    field('选择阶段',select(manualStage,v=>{
     setManualStage(v)
     if(v)setManual(String(c.thresholds[Number(v)-1]))
    },[['','自填分数'],...c.stageNames.map((label,i)=>[String(i+1),label])])),
    field('好感',input(manual,v=>{setManual(v);setManualStage('')},'number',{min:0,max:100,step:.01,className:'number'})),
    field('情欲',input(manualArousal,v=>setManualArousal(v),'number',{min:0,max:100,step:1,className:'number'}))
   ),
   h('div',{className:'row dialog-actions'},btn('取消',()=>setAdjustOpen(false)),btn('保存调整',async()=>{
    const changes={}
    if(Number(manual)!==adjustStart.current.score)changes.score=Number(manual)
    if(manualArousal!==''&&Number(manualArousal)!==adjustStart.current.arousal)changes.arousal=Number(manualArousal)
    if(!Object.keys(changes).length){setAdjustOpen(false);return}
    await post('/adjust',{persona,...changes,expectedRevision:s.revision})
    setAdjustOpen(false)
    await load()
    setMessage('当前关系已调整。')
   },dirty||manual===''||Number(manual)<0||Number(manual)>100||(manualArousal!==''&&(Number(manualArousal)<0||Number(manualArousal)>100)),'primary'))
  )):null
 const resetTool=s?fold('重新开始关系',
  hint('清空此人格当前主人的好感、情欲进度与相处记录，再选择好感起点和成长节奏。'),
  reset?h('div',{className:'notice warn stack'},
   h('p',null,'确认清空这段关系的进度和记录？'),
   row(btn('确认重新开始',async()=>{
    await post('/reset',{persona,expectedRevision:s.revision,expectedEpoch:s.epoch,confirmed:true,restart:true})
    await load();setSection('basics');navigate('settings')
   },dirty,'danger'),btn('取消',()=>setReset(false)))):btn('重新开始关系',()=>setReset(true),dirty,'danger')):null
 const segment=s&&s.stage<5?Math.max(0,Math.min(1,(s.score-c.thresholds[s.stage-1])/(c.thresholds[s.stage]-c.thresholds[s.stage-1]))):0
 const progress=s?Math.min(100,(s.stage-1+segment)*25):0
 const currentPanel=s?h('section',{className:'card relationship-hero','aria-label':'关系概况'},
  h('div',{className:'relationship-art','aria-hidden':true}),
  h('div',{className:'stage-journey','aria-label':'五个关系阶段',style:{'--fill':progress+'%'}},
   h('div',{className:'journey-track','aria-hidden':true},h('span')),
   ...c.stageNames.map((label,i)=>{
    const stage=i+1,located=overviewStage===stage
    return h('button',{type:'button',key:stage,className:'journey-step','aria-label':'查看进入'+label+'的记录',
     'data-step':stage,'data-reached':stage<=s.stage||undefined,'data-located':located||undefined,
     'aria-current':stage===s.stage?'step':undefined,ref:located?locatedStage:undefined,
     onClick:()=>showStageHistory(stage)},h('span',{className:'journey-marker','aria-hidden':true}),h('span',null,label))
   })),
  h('div',{className:'relationship-actions'},switches,appearance,initiative,btn('设置',openSettings,false,'primary'))
 ):h('section',{className:'card empty first-relationship'},h('h3',null,'从你想要的关系开始'),
  hint('选择初始阶段和相处方式，为此角色建立关系。'),
  btn('设置这段关系',()=>{navigate('settings');setSection('basics')},false,'primary'))
 const openFilters=()=>{setFilterDraft({filter,axis,fromDate,toDate,stageOnly,stageTo,previousHistory,sourceFilter});setFilterOpen(true)}
 const filterField=(key,value)=>setFilterDraft(current=>({...current,[key]:value}))
 const filterModal=h('dialog',{ref:filterDialog,className:'relation-dialog filter-dialog','aria-labelledby':'lr-filter-title',onClose:()=>setFilterOpen(false)},
  filterDraft?h('div',{className:'filter-layout'},
   h('h3',{id:'lr-filter-title'},'筛选相处记录'),
   h('div',{className:'filter-fields'},
   grid(field('记录类型',select(filterDraft.filter,v=>filterField('filter',v),[['all','全部记录'],['up','好感增加'],['down','好感减少'],['flat','没有变化'],['revoked','已撤销'],['privacy','来源已遗忘'],['manual','手动调整']])),
    field('进入阶段',select(filterDraft.stageTo,v=>filterField('stageTo',v),[['','全部阶段'],...c.stageNames.map((n,i)=>[String(i+1),n])]))),
   grid(field('开始日期',input(filterDraft.fromDate,v=>filterField('fromDate',v),'date')),field('结束日期',input(filterDraft.toDate,v=>filterField('toDate',v),'date'))),
   field('变化类型',select(filterDraft.axis,v=>filterField('axis',v),[['all','所有变化'],['relation','好感'],['mood','心情'],['arousal','情欲']])),
   field('来源消息（可选）',input(filterDraft.sourceFilter,v=>filterField('sourceFilter',v),'text',{placeholder:'留空查看所有来源'})),
   grid(check('只看阶段变化',filterDraft.stageOnly,v=>filterField('stageOnly',v)),check('包括重新开始前的记录',filterDraft.previousHistory,v=>filterField('previousHistory',v)))),
   h('div',{className:'row filter-actions'},btn('重置筛选',()=>setFilterDraft({filter:'all',axis:'all',fromDate:'',toDate:'',stageOnly:false,stageTo:'',previousHistory:false,sourceFilter:''})),
    btn('取消',()=>setFilterOpen(false)),btn('应用筛选',()=>{setFilter(filterDraft.filter);setAxis(filterDraft.axis);setFromDate(filterDraft.fromDate);setToDate(filterDraft.toDate);setStageOnly(filterDraft.stageOnly);setStageTo(filterDraft.stageTo);setPreviousHistory(filterDraft.previousHistory);setSourceFilter(filterDraft.sourceFilter);setPage(0);setFilterOpen(false)},false,'primary'))
  ):null)
 const eventsPanel=stack(semantic?h('section',{className:'card stack'},h('h3',null,'重新理解这次互动'),semantic.preview?stack(hint(semantic.preview.note),h('p',null,'好感 '+semantic.preview.before.score+' → '+semantic.preview.after.score+'；心情补偿 '+semantic.preview.moodDelta),...(semantic.events||[]).map((e,i)=>hint(e.label)),row(btn('确认采用重判结果',async()=>{await post('/semantic-confirm',{id:semantic.id,confirmed:true});await load();setMessage('已更新判断并重算后续变化。')},dirty,'primary'),btn('放弃重判结果',()=>setSemantic(null)))):stack(hint(semantic.warning),hint('最多 '+semantic.requests+' 次；单次输入 '+semantic.maxInputTokens+'／输出 '+semantic.maxOutputTokens+' token。'),row(btn('同意本次用量并生成预览',async()=>{const r=await post('/semantic-evaluate',{id:semantic.id,confirmed:true});setSemantic(r)},dirty,'primary'),btn('取消重判',()=>setSemantic(null))))):null,proofReview?h('section',{className:'card stack'},h('h3',null,'核对补充的依据'),h('p',null,'好感 '+proofReview.before.score+' → '+proofReview.after.score+'；心情补偿 '+proofReview.moodDelta+'。'),hint(proofReview.note),hint('会重新计算这次及后续 '+proofReview.affected+' 条记录。'),row(btn('确认这次复核',async()=>{await post('/review',{persona,entryId:proofReview.entryId,expectedRevision:proofReview.expectedRevision,token:proofReview.token,confirmed:true});await load();setMessage('已按可核对的依据更新记录。')},dirty,'primary'),btn('取消复核',()=>setProofReview(null)))):null,undo?h('section',{className:'card stack'},h('h3',null,'撤销这次判断'),h('p',null,'好感将从 '+undo.before.score+' 变为 '+undo.after.score+'，阶段 '+undo.before.stage+' → '+undo.after.stage+'。'),hint('后续 '+undo.affected+' 条关联记录会重新计算，聊天内容保留。'),field('纠错原因',input(undoReason,setUndoReason,'text',{maxLength:300})),row(btn('确认撤销',async()=>{await post('/undo-live',{persona,entryId:undo.entryId,expectedRevision:undo.expectedRevision,reason:undoReason,confirmed:true});await load();setMessage('已撤销，并重新计算后续变化。')},dirty||!undoReason.trim(),'primary'),btn('取消撤销',()=>setUndo(null)))):null,h('section',{className:'card timeline-card','aria-labelledby':'lr-timeline-title'},h('div',{className:'timeline-heading'},h('div',{className:'section-title'},h('h3',{id:'lr-timeline-title',ref:timelineTitle,tabIndex:-1},'相处记录')),h('div',{className:'timeline-actions'},btn('刷新',()=>load(),dirty,'quiet'),btn('筛选',openFilters),btn('调整',openAdjustment,dirty||!s))),stageTo?h('div',{className:'row timeline-selection'},h('span',null,'进入 '+c.stageNames[Number(stageTo)-1]+' 的记录'),btn('清除阶段筛选',()=>{setStageTo('');setStageOnly(false);setPage(0)},false,'quiet')):null,historyBusy?h('div',{className:'empty'},'正在读取记录…'):events.length?h('div',{className:'timeline'},...events.map(e=>eventView(e))):h('div',{className:'empty'},'这里还没有符合条件的记录。'),state.lastIssue?fold('最近一次判定未完成',hint(state.lastIssue)):null,history.total>10?h('div',{className:'row between pagination'},hint('共 '+history.total+' 条记录'),row(btn('上一页',()=>setPage(p=>p-1),page===0||historyBusy),h('small',null,(page+1)+' / '+Math.max(1,Math.ceil(history.total/10))),btn('下一页',()=>setPage(p=>p+1),historyBusy||(page+1)*10>=history.total))):null))
 const mergePanel=mergeReview?h('section',{className:'card stack'},h('h3',null,'合并其他窗口的修改'),hint('未冲突的修改会自动合并。下面这些设置两边都改过，需要选定保留哪一份。'),...mergeReview.conflicts.map(item=>h('div',{className:'stack',key:item.path},h('strong',null,settingNames[item.path.split('.')[0]]||'相处设置'),grid(h('div',null,h('small',null,'我的修改'),h('p',null,showSetting(item.local)),btn('保留我的修改',()=>chooseMerge(item.path,item.local,'我的修改'))),h('div',null,h('small',null,'另一窗口'),h('p',null,showSetting(item.remote)),btn('使用另一窗口',()=>chooseMerge(item.path,item.remote,'另一窗口')))),mergeReview.choices[item.path]?hint('已选择：'+mergeReview.choices[item.path]):null)),row(btn('使用合并后的草稿',()=>{setState(v=>({...v,row:{...v.row,config:mergeReview.latest,configRevision:mergeReview.revision}}));setDraft(mergeReview.merged);setMergeReview(null);setDirty(true)},mergeReview.conflicts.some(c=>!mergeReview.choices[c.path])),btn('暂不合并',()=>setMergeReview(null)))):null
 function openSettings(){setSection('basics');setSupport('backup');navigate('settings')}
 const settingsCards=[
  ['basics','相处与情欲','成长节奏、恋爱背景和情欲表达','◈',()=>stack(basics,fold('情欲设定',intimacy))],
  ['more','资料与恢复','备份、重开与维护','≡',morePanel]
 ]
 const settingsPanel=h('div',{className:'settings-cards'},
  ...settingsCards.map(([id,title,description,glyph,content])=>{
   const open=section===id
   return h('section',{className:'card settings-card',key:id},
    h('button',{className:'settings-card-trigger',type:'button','aria-expanded':open,onClick:()=>setSection(open?null:id)},
     icon('setting-icon',glyph),h('span',{className:'setting-card-copy'},h('strong',null,title),h('small',null,description)),
     h('span',{className:'expand-indicator','aria-hidden':true})),
    open?h('div',{className:'settings-card-body'},content()):null)
  }))
 const settingsView=tab==='settings'
 return h('div',{className:'lr','data-relation-stage':s?.stage||1},h('style',null,relationTheme+relationPanelStyle+romanceEditorStyle+"@media(max-width:540px){.lr .relationship-hero .relationship-art{left:50%;right:auto;transform:translateX(-50%);width:clamp(72px,24vw,108px);height:78px;top:40px}}.lr .relation-metrics{display:grid;align-content:start;justify-self:end;gap:10px;position:relative;z-index:1}.lr .relation-metric{display:flex;justify-content:flex-end;align-items:flex-end;gap:5px;font-variant-numeric:tabular-nums}.lr .relation-metric strong{font-size:40px;line-height:.95;color:var(--stage-ink);font-weight:700}.lr .relation-metric.arousal strong{font-size:20px}.lr .relation-metric .metric-unit{display:grid;gap:2px;justify-items:end;align-content:end;color:var(--muted);white-space:nowrap}.lr .relation-metric .metric-unit>*{font-family:inherit;font-weight:500;font-size:11px;line-height:12px;margin:0;padding:0}.lr .relation-metric .metric-unit small{font-weight:600}"),
  settingsView?h('header',{className:'module-head rv-settings-head'},
      h('div',null,h('h2',null,'恋爱设置'),hint(name(persona)+(persona===state.runningPersona?' · 当前聊天人格':' · 当前聊天人格为 '+name(state.runningPersona))),!state.configured?hint('确认起点后，点击模块右上角「保存设置」开始相处。'):null),
      h('div',{className:'rv-head-actions'},h('div',{className:'rv-demotion'},
    h('label',{className:'rv-demotion-control'},
      h('span',{className:'lr-switch'},h('input',{type:'checkbox',role:'switch','aria-label':'锁定降阶',
        'aria-describedby':'lr-demotion-note',checked:!!draft.floorLock,disabled:busy,onChange:e=>edit('floorLock',e.target.checked)}),h('span',{'aria-hidden':true})),
      h('span',null,'锁定降阶')),
    h('details',{className:'rv-demotion-info'},h('summary',{'aria-label':'查看锁定降阶说明'},'?'),
      h('p',{id:'lr-demotion-note',className:'hint'},draft.floorLock
      ?'已锁定。自动扣分最低到当前阶段的起点，仍可升阶，也可手动调分。'
      :'默认关闭。好感可以跌破当前阶段的起点。反复发生或经确认的严重伤害，在冷却期外可自动降一阶。也可手动调分。'))),
        h('div',{className:'header-tools'},dirty?btn('放弃修改',()=>load(),false,'quiet'):null,
          btn('返回概况',()=>navigate('current'),dirty,'quiet')))):null,
  message?h('p',{className:'notice '+(error?'warn':''),role:error?'alert':'status'},message):null,
  state.compatibility.issues.length?h('div',{className:'notice warn'},'当前无法正常使用：'+state.compatibility.issues.join('；')):null,
  state.resetPending?h('p',{className:'notice warn'},'关系重开正在同步。可在「资料与恢复 → 备份与恢复」继续完成。'):null,
  state.outbox?.length?h('p',{className:'notice'},'部分相处记录正在同步，请稍后刷新。'):null,
  h('div',{className:'relation-workspace'},
   h('div',{className:'relation-main'},
    settingsView?settingsPanel:state.configured?stack(currentPanel,eventsPanel):stack(h('section',{className:'card stack'},h('h3',null,'开始这段关系'),hint('先选择好感起点和成长节奏。'),row(switches,btn('设置相处方式',openSettings,false,'primary')))),
    mergePanel)),
  manualDialog,filterModal,
  h('footer',{className:'footer'},hint('恋爱进行时 · '+state.version)))
}

})()
}
function relationshipStyles(){return `.rv-page,.rv-page [data-relation-root]{min-width:0}
.rv-page .lr{padding:0}
.rv-page .lr .relation-workspace{display:block}
.rv-page .lr .relation-main>.stack{gap:15px}
.rv-page .lr .relationship-hero{
  grid-template-columns:minmax(0,1fr);row-gap:5px;padding:8px 20px;min-height:0;
}
.rv-page .lr .card.relationship-hero{padding-block:8px}
.rv-page .lr .relationship-hero .relationship-art{
  position:absolute;inset:0 3px auto auto;width:min(8%,85px);height:38px;
  opacity:.38;transform:none;pointer-events:none;
}
.rv-page .lr button.journey-step{min-height:48px}
.rv-page .lr .relationship-actions{grid-column:1/-1;display:flex;justify-content:flex-start;gap:8px 20px}
.rv-page .lr .relationship-actions>button{margin-left:auto}
.rv-page .lr .relationship-actions .module-enable{display:flex}
.rv-page .lr .module-head{padding:0}
.rv-page .lr .rv-settings-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px 12px}
.rv-page .lr .rv-settings-head h2,.rv-page .lr .rv-settings-head .hint{margin:0}
.rv-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;white-space:nowrap}
.rv-page .lr .rv-head-actions .header-tools{flex-wrap:nowrap;justify-content:flex-end}
@media(max-width:540px){.rv-page .lr .rv-settings-head{grid-template-columns:minmax(0,1fr)}}
.rv-demotion{display:flex;align-items:center;gap:4px;position:relative}
.rv-demotion-control{display:inline-flex;align-items:center;gap:8px;justify-self:start;cursor:pointer}
.rv-demotion-info>summary{display:grid;place-items:center;width:22px;height:24px;list-style:none;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer}
.rv-demotion-info>summary::-webkit-details-marker{display:none}
.rv-page .lr .kink-tags{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px 8px;align-items:center}
@media(max-width:820px){.rv-page .lr .kink-tags{grid-template-columns:repeat(auto-fit,minmax(min(100%,6.5rem),1fr))}}
.rv-page .lr .rv-demotion-info p{position:absolute;z-index:3;inset-inline-end:0;top:100%;width:min(32ch,76vw);margin:4px 0;padding:8px 12px;background:var(--surface,#fff);color:var(--ink);border:1px solid var(--line);border-radius:8px;box-shadow:0 5px 15px #192e4915}
.rv-page .lr .timeline-heading .timeline-actions{flex-wrap:wrap}
.rv-page .lr .rv-changes{display:flex;flex-wrap:wrap;gap:4px 8px;justify-content:flex-end}
.rv-page .lr .rv-changes .delta{white-space:nowrap}
.rv-page .lr .rv-changes .steady{color:var(--muted);background:transparent}
.rv-page .lr .event-progress{margin-bottom:0}
.rv-page .lr dialog{scrollbar-width:thin;max-height:85dvh}
.rv-page .lr .footer{margin:0}
@media(max-width:540px){
  .rv-page .lr .relationship-hero{padding:8px 12px}
  .rv-page .lr .relationship-hero .relationship-art{height:28px}
  .rv-page .lr .relationship-actions{gap:8px 12px}
  .rv-page .lr .relationship-actions .module-enable{display:flex}
  .rv-page .lr .rv-changes{gap:2px 4px}
  .rv-page .lr .rv-changes .delta{padding:2px 5px}
}
@media(max-width:360px){
  .rv-page .lr .relationship-actions{gap:6px}
  .rv-page .lr .relationship-actions .inline-switch{gap:4px}
  .rv-page .lr .relationship-actions .lr-switch{width:34px}
  .rv-page .lr .relationship-actions .lr-switch input:checked+span::after{transform:translateX(10px)}
  .rv-page .lr .relationship-actions>button{padding-inline:8px}
}

`}
