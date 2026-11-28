import {calendarSettings} from './life-calendar.mjs'
import { LIFE_IDENTITIES } from './life-identities.mjs'
const block=(phase,start,end,days,label,location='')=>({id:`${phase}-${start}-${days.join('')}`,phase,start,end,days,label,location})
const all=[0,1,2,3,4,5,6],week=[1,2,3,4,5]
const sleep=(start,end,days=all)=>block('sleep',start,end,days,'休息睡眠')
export const LIFE_PRESETS={
  careers:LIFE_IDENTITIES,
  legacyCareers:[
    {id:'office',name:'日班职员',summary:'工作日白班，有通勤与午休，周末自由安排',patch:{scheduleMode:'weekly',scheduleBlocks:[sleep('00:00','08:00'),block('commute','08:20','09:00',week,'去上班'),block('work','09:00','12:00',week,'上午工作'),block('work','13:00','18:00',week,'下午工作'),block('commute','18:00','18:40',week,'下班回家')],workLabel:'工作',sleepStart:'00:00',wakeTime:'08:00'}},
    {id:'streamer',name:'晚间主播',summary:'晚间直播，白天准备与休息，不预设外向性格',patch:{scheduleMode:'weekly',scheduleBlocks:[sleep('03:00','11:00'),block('work','15:00','17:00',[1,2,4,5,6],'准备直播'),block('work','20:00','02:00',[1,2,4,5,6],'直播时段')],sleepStart:'03:00',wakeTime:'11:00'}},
    {id:'creator',name:'弹性创作者',summary:'分段创作，保留较多自主时间',patch:{scheduleMode:'weekly',scheduleBlocks:[sleep('01:00','09:00'),block('work','10:00','12:00',week,'集中创作'),block('work','15:00','17:00',week,'继续创作')],sleepStart:'01:00',wakeTime:'09:00'}},
    {id:'shifts',name:'轮班服务',summary:'四天一个周期：白班、夜班、夜班后休息、休息日',patch:{scheduleMode:'rotation',rotationDays:4,scheduleBlocks:[sleep('00:00','07:00',[0,1,3]),sleep('07:00','15:00',[2]),block('commute','07:30','08:00',[0],'上班通勤'),block('work','08:00','17:00',[0],'白班'),block('commute','17:00','17:30',[0],'回家通勤'),block('work','22:00','06:00',[1],'夜班')],sleepStart:'00:00',wakeTime:'07:00'}},
    {id:'cabin',name:'航空乘务',summary:'示例出勤与轮休；由玩家调整，不绑定真实航班',patch:{scheduleMode:'rotation',rotationDays:4,scheduleBlocks:[sleep('23:00','07:00',[0,1,2,3]),block('commute','08:00','09:00',[0,1],'出勤路上'),block('work','09:00','17:00',[0,1],'乘务出勤'),block('commute','17:00','18:00',[0,1],'出勤结束返回')],sleepStart:'23:00',wakeTime:'07:00'}},
    {id:'study',name:'学习生活',summary:'上午与下午学习，晚间自由安排',patch:{scheduleMode:'weekly',scheduleBlocks:[sleep('23:30','07:30'),block('work','09:00','12:00',week,'学习'),block('work','14:00','17:00',week,'学习与练习')],sleepStart:'23:30',wakeTime:'07:30'}},
  ],
  temperaments:[
    {id:'quiet',name:'独处充电',summary:'偏向安静的休闲选择，不修改原卡性格',conflict:['无法忍受独处','讨厌独处'],patch:{interests:['看书','听音乐','写随记']}},
    {id:'social',name:'小范围社交',summary:'有闲暇时可和熟悉的朋友聊聊',conflict:['厌恶社交','不喜欢社交','讨厌社交','不愿社交','很少与人来往','回避社交'],patch:{interests:['和朋友聊近况']}},
    {id:'steady',name:'规律整理',summary:'空闲时可安排一点整理或伸展',patch:{interests:['整理房间','伸展运动','看书']}},
    {id:'easy',name:'随兴休息',summary:'有空就听听音乐、随手画画或休息',patch:{interests:['听音乐','随手画画','自由休息']}},
    {id:'immersed',name:'创作沉浸',summary:'把空闲留给可持续的创作兴趣',conflict:[],patch:{interests:['画画','写作','练习乐器']}},
  ],
  lifestyles:[
    {id:'home',name:'居家为主',summary:'主要在住处休闲，不填写具体住址',patch:{interests:['看书','听音乐','做点简单料理']}},
    {id:'outdoors',name:'常外出',summary:'适合散步、咖啡馆等空闲活动',patch:{places:['附近公园','咖啡馆'],interests:['散步','去咖啡馆坐坐']}},
    {id:'exercise',name:'轻运动',summary:'日常加入短时运动和休息',patch:{interests:['伸展运动','散步','听音乐']}},
    {id:'night',name:'晚间休闲',summary:'留些安静的活动选项，休息时间按日程执行',patch:{interests:['听音乐','看书','记录灵感']}},
    {id:'balanced',name:'均衡日常',summary:'动静结合，允许空闲什么也不做',patch:{interests:['散步','看书','做点简单料理']}},
  ],
  examples:LIFE_IDENTITIES.map(x=>({name:x.name,selection:{career:x.id}})),
}
const blank=v=>v===undefined||v===null||v===''||Array.isArray(v)&&!v.length
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const timetableFields=['scheduleMode','scheduleBlocks','scheduleAnchor','rotationDays','sleepStart','wakeTime','workEnabled','workDays','workStart','workEnd','workLabel']

export function presetPreview({config={},selection={},replace=false,cardText='',defaults={},hasSaved=false,scheduleOnly=false,upgradeGroups=[]}){
  const patch={},warnings=[],groups=[['career','careers'],['temperament','temperaments'],['lifestyle','lifestyles']]
  const selected={...config.presetSelection}
  for(const [kind,list] of groups){
    if(!selection[kind])continue
    const p=LIFE_PRESETS[list].find(p=>p.id===selection[kind])||(kind==='career'?LIFE_PRESETS.legacyCareers.find(p=>p.id===selection[kind]):null);if(!p)throw Error('生活预设不存在')
    if(p.conflict?.some(phrase=>cardText.includes(phrase))){
      warnings.push(`${p.name}与人格卡的明确描述可能冲突，已跳过这组闲暇偏好。`)
      continue
    }
    selected[kind]=p.id
    for(const [key,value] of Object.entries(p.patch)){
      if(scheduleOnly&&!timetableFields.includes(key))continue
      if(Array.isArray(value)&&key!=='scheduleBlocks')patch[key]=[...new Set([...(patch[key]||[]),...value])].slice(0,12)
      else patch[key]=structuredClone(value)
    }
  }
  if(patch.scheduleBlocks)patch.scheduleBlocks=calendarSettings({...config,...patch}).scheduleBlocks
  const changes=[],skipped=[],result=structuredClone(config)
  const defaultValue=key=>!hasSaved&&same(config[key],defaults[key])
  const mayFill=key=>blank(config[key])||defaultValue(key)
  const oldCareer=LIFE_PRESETS.legacyCareers.find(x=>x.id===config.presetSelection?.career)
  const oldChoices=[oldCareer,...['temperaments','lifestyles'].map((list,i)=>LIFE_PRESETS[list].find(x=>x.id===config.presetSelection?.[['temperament','lifestyle'][i]]))].filter(Boolean)
  const legacyInterests=[...new Set(oldChoices.flatMap(x=>x.patch.interests||[]))]
  const upgrading=config.presetVersion===1 && selection.career===oldCareer?.id && Array.isArray(upgradeGroups)
  const previous=oldCareer && {...defaults,...oldCareer.patch,...calendarSettings(oldCareer.patch)}
  const oldTimetable=!!previous && timetableFields.every(k=>same(config[k],previous[k]))
  function upgrade(key){
    if(!upgrading)return false
    if(timetableFields.includes(key))return oldTimetable&&upgradeGroups.includes('schedule')
    if(key==='interests')return same(config.interests,legacyInterests)&&upgradeGroups.includes('interests')
    return false
  }
  const protectedSchedule=timetableFields.some(key=>!mayFill(key))
  for(const [key,value] of Object.entries(patch)){
    if(same(config[key],value))continue
    const changesTimetable=timetableFields.includes(key)
    if(replace||upgrade(key)||(!changesTimetable||!protectedSchedule)&&mayFill(key)){
      result[key]=value;changes.push({key,before:config[key],after:value})
    }else skipped.push(key)
  }
  if(skipped.some(key=>timetableFields.includes(key))){
    warnings.push('已保留现有作息。要采用所选班表，请在预览中选择替换涉及的字段。')
    if(selection.career)selected.career=config.presetSelection?.career||''
  }
  if(changes.length){result.presetSelection=selected;result.presetVersion=upgrading&&!replace&&skipped.some(k=>timetableFields.includes(k)||k==='interests')?1:2}
  return {config:result,changes,skipped,warnings:[...new Set(warnings)]}
}
