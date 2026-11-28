// Presets describe editable fictional lives, never replace a persona's identity or temperament.
const all=[0,1,2,3,4,5,6],week=[1,2,3,4,5],off=[0,6]
const b=(phase,start,end,days,label,location='')=>({id:[phase,start,...days].join('-'),phase,start,end,days,label,location})
function weekly(id,name,{sleep=['23:30','07:00'],morning='上午事务',afternoon='下午事务',place='',places=[],items=[],interests=[],change='',share='',hours=['09:00','12:00','14:00','17:00'],rest='自由休整',extra=[]}={}){
  const blocks=[b('sleep',...sleep,all,'休息睡眠'),b('free','07:15','07:45',week,'早餐与整理'),b('work',hours[0],hours[1],week,morning,place),
    b('free','12:00','13:00',week,'午餐与短休'),b('work',hours[2],hours[3],week,afternoon,place),b('free','18:30','19:30',all,'晚餐与放松'),
    b('free','10:00','12:00',off,rest),...extra]
  return {id,name,summary:`${morning} · ${change} · ${rest}`,dayTypes:{regular:morning+'、'+afternoon,variation:change,rest},share,
    patch:{scheduleMode:'weekly',scheduleBlocks:blocks,sleepStart:sleep[0],wakeTime:sleep[1],workLabel:name+'日常',workPlace:place,
      places,items,interests,notes:`生活示例，可改写：${change}。休整时${rest}。互动素材：${share}。这些是候选，不表示已经发生；核心性格和身份以原卡为准。`}}
}
const teacher=weekly('teacher','教师',{morning:'备课、上课与答疑',afternoon:'批改作业与教研',place:'学校',places:['书店','陶艺工作室','公园'],items:['教案本','彩色粉笔','便当盒'],interests:['逛书市','做趣味教具','练陶艺','散步'],change:'校园活动日做趣味演示，教研日交换新点子',rest:'逛书市或留家读书',share:'一起试解小谜题、挑教具配色、讲今天有趣的教学片段'})
const secondary=weekly('secondary','中学生',{sleep:['22:30','06:30'],hours:['08:00','12:00','13:30','17:00'],morning:'早读与上午课程',afternoon:'下午课程与班级活动',place:'学校',places:['图书馆','文具店','操场'],items:['书包','习题本','社团徽章'],interests:['画手账','社团练习','打球','看漫画'],change:'社团日排练、运动会或小组展示',rest:'做手账、看漫画或和同学打球',share:'作业难题、社团练习进度、挑文具；不推断或改变原卡年龄',extra:[b('free','19:45','21:00',week,'整理功课与自由阅读')]})
const university=weekly('university','大学生',{sleep:['00:30','07:00'],morning:'课程与实验',afternoon:'图书馆自习或小组项目',place:'校园',places:['校园咖啡馆','社团教室','图书馆'],items:['笔记本电脑','校园卡','实验笔记'],interests:['社团排练','拍校园照片','去咖啡馆坐坐','阅读'],change:'无课日下午留给社团或项目，周末可逛校园周边',rest:'社团活动或自由休息',share:'课堂趣闻、项目卡点、社团小演出和选课烦恼'})
const nurse=weekly('nurse','护士',{sleep:['23:00','06:30'],hours:['08:00','12:00','13:00','16:00'],morning:'交班与护理工作',afternoon:'护理、记录与交班',place:'医院',places:['花店','咖啡馆','附近公园'],items:['保温杯','便当盒','花艺剪'],interests:['插花','练咖啡拉花','散步','听音乐'],change:'轮值时可改成夜班并安排补眠，不连续塞入白班；休整日试拉花或露营',rest:'插花或慢慢吃早午餐',share:'选便当、夜班后的早餐、拉花练习；不分享患者隐私'})
const doctor=weekly('doctor','医生',{sleep:['23:30','06:30'],hours:['08:00','12:00','13:30','17:30'],morning:'门诊或查房',afternoon:'病例学习与科室事务',place:'医院',places:['书店','音乐厅','公园'],items:['笔记本','保温杯','乐谱'],interests:['听古典音乐','读小说','散步','练乐器'],change:'教学交流日或轮值日可改班，休整时放下工作',rest:'听音乐或读与工作无关的书',share:'学习收获、日常小发现和音乐；不编造患者资料或诊疗结果'})
const office=weekly('office','OL',{morning:'项目沟通与办公',afternoon:'推进任务与收尾',place:'办公室',places:['午餐小店','商场','健身房'],items:['通勤包','咖啡杯','工作手账'],interests:['探午餐小店','逛街','轻运动','追剧'],change:'居家办公日、项目收尾或同事聚餐',rest:'逛街或追剧',share:'午餐投票、通勤小插曲、周五的放松计划'})
const executive=weekly('executive','总裁',{morning:'提案阅读与决策会',afternoon:'商务会面与自主事务',place:'办公室',places:['艺术馆','网球场','餐厅'],items:['日程本','运动包','艺术画册'],interests:['看展','打网球','骑行','做料理'],change:'艺术预览或私人晚餐替换部分会面，休息日可安排游艇或宅家',rest:'运动、看展或留家放松',share:'一起挑展览、选晚餐、讨论有趣提案；不预设强势性格或炫富'})
const artist=weekly('creator','画家',{morning:'速写与试色',afternoon:'绘画创作与整理作品',place:'画室',places:['公园','画材店','艺术馆'],items:['颜料盒','速写本','画架'],interests:['外出写生','逛画材店','看展','看书'],change:'写生日带速写本出门，布展日准备作品',rest:'逛展或随手涂鸦',share:'邀请选配色、延续上次的画、拍色卡或写生见闻'})
const streamer=weekly('streamer','主播',{sleep:['03:00','11:00'],morning:'准备选题',afternoon:'准备直播',place:'家中工作区',places:['咖啡馆','公园','游戏店'],items:['麦克风','直播手账','游戏手柄'],interests:['试玩游戏','剪辑片段','散步','看动漫'],change:'休播日不安排直播，可整理片段、出门放松或临时联动',rest:'休播放松',share:'选下次直播内容、下播后的趣事、一起研究游戏'})
streamer.patch.scheduleBlocks=[b('sleep','03:00','11:00',all,'休息睡眠'),b('free','11:20','12:00',all,'早午餐'),b('work','15:00','17:00',[1,2,4,5,6],'准备直播','家中工作区'),b('free','18:00','19:00',all,'晚餐与休息'),b('work','20:00','02:00',[1,2,4,5,6],'直播时段','家中工作区'),b('free','02:00','02:30',[0,2,3,5,6],'下播后放松与整理'),b('free','15:00','17:00',[0,3],'休播日自由活动')]
const police=weekly('police','警察',{sleep:['23:00','06:30'],morning:'交接班与例行巡查',afternoon:'训练与文书事务',place:'工作单位',places:['运动场','面馆','公园'],items:['运动包','水壶','小说'],interests:['跑步','探面馆','看推理小说','修小物件'],change:'值班日可调整班次，休息日运动或修理小物件',rest:'跑步或看小说',share:'运动记录、面馆发现；不编造案件机密或真实执法行动'})
const cabin=weekly('cabin','空乘',{sleep:['23:00','07:00'],morning:'出勤准备与乘务工作',afternoon:'乘务工作与收班',place:'出勤地点',places:['咖啡馆','市集','书店'],items:['行李箱','旅行手账','保温杯'],interests:['逛市集','旅行手账','拉伸','拍街景'],change:'示例出勤日与轮休日交替，轮休时探店或在住处休息，不编造真实航班',rest:'轮休探店或宅家',share:'行李小物、轮休见闻、挑伴手礼；地点只在确认后切换'})
cabin.patch.scheduleBlocks=[b('sleep','23:00','07:00',all,'休息睡眠'),b('free','07:20','08:00',all,'早餐'),b('work','09:00','12:00',[1,2,4,5],'乘务出勤'),b('free','12:00','13:00',[1,2,4,5],'轮流用餐'),b('work','13:00','17:00',[1,2,4,5],'乘务工作与收班'),b('free','18:30','19:30',all,'晚餐'),b('free','10:00','12:00',[0,3,6],'轮休自由活动')]
const shrine=weekly('shrine','巫女',{sleep:['23:00','06:30'],morning:'神社清扫与接待',afternoon:'整理授与品与练习',place:'神社',places:['神社庭院','和菓子店','商店街'],items:['练习扇','手账','茶具'],interests:['练舞','喝茶','逛商店街','观察庭院'],change:'祭典准备、季节布置或舞蹈练习，休整日也可过现代日常生活',rest:'逛商店街或品茶',share:'祭典配色、庭院变化、和菓子口味；不强加神秘能力'})
const star=weekly('star','明星',{morning:'剧本阅读与造型准备',afternoon:'拍摄或宣传工作',place:'工作现场',places:['排练室','咖啡馆','电影院'],items:['剧本','耳机','拍立得'],interests:['看电影','拍生活碎片','散步','做料理'],change:'拍摄日、宣传日和休息日可调整，不每天固定通告',rest:'看电影或做料理',share:'不泄密的片场小事、台词练习、休息日的反差日常'})
const idol=weekly('idol','偶像',{morning:'舞蹈与声乐练习',afternoon:'排练与录制',place:'练习室',places:['练习室','甜品店','公园'],items:['练习服','水壶','舞蹈笔记'],interests:['练舞','听新歌','逛甜品店','拍穿搭'],change:'舞台日提前准备造型和声乐，休整日降低训练强度',rest:'找甜品或安静听歌',share:'新舞步进度、舞台服装选择、练习后的奖励'})
const voice=weekly('voice','声优',{morning:'读本与发声练习',afternoon:'录音与试听',place:'录音棚',places:['录音棚','书店','茶饮店'],items:['台本','润喉水','耳机'],interests:['朗读','看动画','品茶','散步'],change:'试音日、正式录音日与休声日有区别',rest:'休声、看书或散步',share:'台词理解、不同声线的轻松练习、录音后的小发现'})
const heiress=weekly('heiress','千金',{sleep:['01:00','09:00'],morning:'自由兴趣',afternoon:'自由安排',places:['艺术馆','马术场','网球场','游乐园','宴会厅','游艇码头'],items:['艺术画册','收藏册','礼服配饰盒'],interests:['看展','骑马','打网球','去游乐园','收藏整理','练舞','玩游戏','做甜点'],change:'自由玩乐日可选策展预览、私人兴趣课、游艇聚会；社交盛会日午后挑礼服，晚间舞会或慈善活动，宴会不是每天必办',rest:'居家兴趣日，创作、游戏或整理收藏',share:'邀请选画展或游乐园、陪挑礼服、分享刚学会的事；不预设傲慢性格、佣人、地址或强制消费'})
heiress.patch.scheduleBlocks=[b('sleep','01:00','09:00',all,'休息睡眠'),b('free','10:00','11:00',all,'慢慢吃早午餐'),b('free','14:00','17:00',[1,3,5],'自主玩乐或兴趣课'),b('free','14:00','17:00',[0,2,4,6],'居家兴趣或临时邀约'),b('free','18:30','19:30',all,'晚餐'),b('free','20:00','22:00',[6],'可选社交盛会或自由休闲')]
heiress.patch.scheduleBlocks.push(b('free','20:00','22:00',[0,1,2,3,4,5],'收藏、游戏或与朋友轻松聊天'))
heiress.patch.workEnabled=false
export const LIFE_IDENTITIES=[teacher,secondary,university,nurse,doctor,office,executive,artist,streamer,police,cabin,shrine,star,idol,voice,heiress]

// A variation occupies an existing weekly slot so reapplying a preset never stacks two shifts.
const variations=[
  [teacher,'批改作业与教研',5,'校园活动：准备趣味实验','学校'],
  [secondary,'下午课程与班级活动',3,'社团排练与小组展示','社团教室'],
  [university,'图书馆自习或小组项目',4,'无课日下午：社团小演出','社团教室'],
  [doctor,'病例学习与科室事务',4,'教学交流与读书讨论','医院'],
  [office,'推进任务与收尾',5,'居家整理项目，挑选周末午餐店','家中工作区'],
  [executive,'商务会面与自主事务',5,'收藏展预览与自由交流','艺术馆'],
  [artist,'绘画创作与整理作品',3,'带速写本外出写生','公园'],
  [streamer,'准备直播',5,'联动日：试麦、对台本与选游戏','家中工作区'],
  [police,'训练与文书事务',3,'轮训日：体能训练和装备整理','训练场'],
  [cabin,'乘务工作与收班',4,'短班收尾，整理旅行手账','出勤地点'],
  [shrine,'整理授与品与练习',5,'为周末祭典布置庭院与练舞','神社庭院'],
  [star,'拍摄或宣传工作',4,'宣传日：访谈准备与试装','工作现场'],
  [idol,'排练与录制',5,'舞台日：走台和彩排','演出场地'],
  [voice,'录音与试听',3,'新角色试音与台词练习','录音棚'],
  [heiress,'居家兴趣或临时邀约',6,'挑礼服与配饰，准备晚间聚会','家中'],
]
function exceptDay(block,day){block.days=block.days.filter(d=>d!==day)}
for(const [preset,label,day,activity,location] of variations){
  const blocks=preset.patch.scheduleBlocks, original=blocks.find(x=>x.label===label)
  exceptDay(original,day)
  blocks.push(b(original.phase,original.start,original.end,[day],activity,location))
}
const nurseBlocks=nurse.patch.scheduleBlocks
for(const block of nurseBlocks){
  if(block.phase==='work'||block.phase==='sleep')exceptDay(block,5)
  if(block.label===nurse.dayTypes.rest)exceptDay(block,6)
}
nurseBlocks.push(b('free','15:00','17:00',[5],'夜班前小睡或安静休息','家中'),
  b('work','21:00','07:00',[5],'夜班护理与晨间交班','医院'),
  b('sleep','08:30','15:00',[6],'夜班后补眠','家中'))
