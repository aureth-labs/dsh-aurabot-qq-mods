// 她拿主意的那一层：上班是干活还是摸鱼、放假是出门还是在家、手上的活和出门的去处。
// 这里只算「决定了什么、后果有多大」，不发送、不注入、不动别人的模块——
// 那些由 index.mjs 按分享概率和心情去接。全部纯函数，rand 可注入，测试直接跑。
const MIN = 60 * 1000
const HOUR = 60 * MIN

// 上班时手头可能有的活：按职业给池子，抽一条就算今天这件事
// 每个职业 16 条，一天抽 2 条、池内当天不重复，小半个月才会见到同一条
export const WORK_TASKS = {
  office: [
    '把季度报表第三页的数据核对完', '整理下周例会的会议纪要', '给供应商回三封邮件', '把报销单录进系统',
    '重排一遍会议室预订表', '把档案柜里的合同归档', '把上个月的考勤表导出对一遍', '跟财务对一下那笔差旅的费用',
    '带新来的实习生走一遍流程', '改完那份给客户的方案初稿', '把部门群里的通知整理成文档', '打印并装订明天要发的材料',
    '把办公用品的采购清单报上去', '回一遍积压的工单', '把台账里的固定资产编号补齐', '把季度总结的框架搭出来',
  ],
  programmer: [
    '修掉那个偶发的登录超时', '把接口文档补完', '过一遍同事提的代码评审意见', '把单测覆盖率往上拉一截',
    '重构那段谁都不敢动的分页逻辑', '排查线上那条慢查询', '给新接口补上参数校验', '定位那个内存缓慢上涨的问题',
    '拆掉一个用了很久的临时开关', '把构建时间从八分钟压下来一点', '处理两个用户反馈的边界情况', '给这批数据写个迁移脚本',
    '把日志里刷屏的重复报错降噪', '跟前端对一遍字段命名', '补一版灰度回滚的说明', '把遗留的 TODO 清掉几条',
  ],
  teacher: [
    '改完两个班的作文', '备明天上午的两节课', '出一套随堂小测', '把这次月考的成绩录进系统',
    '找两个学生单独聊一聊', '整理下周的教学进度', '把课件的动画再顺一遍', '跟家长通两个电话',
    '把实验器材清点一遍', '排一下下周的值日表', '批完昨天的默写', '准备公开课的教案',
    '把错题按知识点归个类', '跟隔壁班老师对一下进度', '补完这周的听课记录', '把教室后面的板报换一版',
  ],
  doctor: [
    '写完上午门诊的记录', '把三份化验单看完', '跟着主任查一遍房', '补完病程记录',
    '给两个复诊的病人回电话', '把昨天的会诊意见整理进病历', '开完科室的业务学习', '把新收的两个病人问一遍病史',
    '调整一床的用药方案', '把出院小结写完', '核一遍明天的排班', '整理这次的病例讨论材料',
    '把检查申请单补齐', '跟家属谈一次病情', '把值班交接本写完', '翻一眼最新的诊疗指南',
  ],
  nurse: [
    '核对三床的用药单', '写交接班记录', '给两床换输液', '量完整个病区的体温',
    '清点一遍备用药', '整理治疗车', '给新入院的病人做入院宣教', '把压疮护理的记录补上',
    '陪一床去做检查', '把医嘱重新对一遍', '换一遍各床的床单', '记录一遍出入量',
    '给家属讲一遍注意事项', '整理今天的手术交接单', '检查一遍抢救车', '把健康教育的材料发下去',
  ],
  restaurant: [
    '备好午市的凉菜', '把大厅的桌子擦一遍', '清点酒水库存', '帮后厨搬一趟货',
    '记一遍明天的订位', '把菜单上的价格牌换新', '检查一遍冰箱的温度记录', '教新来的服务员摆台',
    '处理一桌客人的投诉', '调一下外卖平台的接单设置', '清点一遍餐具', '把后厨的地面冲一遍',
    '跟供货商对一下今天的菜价', '排一遍下周的班', '把过期的食材清出去', '收拾一下包间',
  ],
  sales: [
    '接待三波来看车的客人', '把展车擦一遍', '回访上周留电话的客户', '盘一遍库存款式',
    '整理这个月的成交单', '给试驾的车加满油', '跟金融那边对一下分期方案', '拍一组新车内饰发朋友圈',
    '跟进一个犹豫了半个月的客户', '把展厅的宣传物料换一版', '参加早会听一遍这个月的任务', '整理客户档案里的联系方式',
    '陪一组客人试驾', '把交车的手续准备好', '统计一下这个月的到店量', '跟售后对一下交车时间',
  ],
  courier: [
    '跑完午高峰那十二单', '给电瓶换组电池', '处理两个超时单的申诉', '把保温箱刷一遍',
    '把片区里新开的几家店记一下', '给一批件重新分拣', '联系一个电话打不通的收件人', '把今天的单量对一遍账',
    '帮同事顶两趟急单', '去站点取一批新件', '把电动车送去修一下刹车', '给一个大件送到六楼',
    '整理一下后备箱里的件', '跟客户解释一次延迟', '把雨具和防水袋备好', '跑一趟郊区的远单',
  ],
  security: [
    '把小区巡两遍', '登记来访车辆', '盯一会儿监控', '检查消防通道有没有堆东西',
    '跟换班的同事交接', '把门禁卡的系统更新一下', '处理一次业主的投诉', '检查一遍地下车库的照明',
    '记录一遍夜间的巡查点', '帮业主抬一次东西', '把快递柜旁边的杂物清掉', '试一遍消防广播',
    '核对一遍临停车辆的收费', '把值班室的记录本补齐', '引导一次救护车进小区', '检查一遍各个门的闭门器',
  ],
  factory: [
    '做完今天的定额', '检查一遍机器', '清理工位', '记录这一批的良品率',
    '换一套磨损的刀具', '把上料的活干完', '跟质检对一下昨天的返工件', '参加班前的安全会',
    '给设备加一次润滑油', '清点一遍物料', '把不良品分类登记', '调一下机器的参数',
    '搬一批成品入库', '填写设备点检表', '教新来的同事上料', '打扫一遍车间的通道',
  ],
  student: [
    '写完物理卷子最后两道大题', '背三十个单词', '整理错题本', '把数学作业交了',
    '复习明天的测验', '把化学笔记补完', '抄一遍英语的范文', '做一套历史的单选题',
    '把语文的默写重默一遍', '问老师一道没听懂的题', '把生物的实验报告写完', '跟同桌对一下答案',
    '预习明天要讲的内容', '把卷子按科目整理好', '补完上周落下的笔记', '把作文的提纲列出来',
  ],
}

// 上班摸鱼能摸成什么样
export const SLACKS = [
  '躲在茶水间刷了会儿手机', '趴在工位上眯了十分钟', '跟同事在走廊上聊了几句', '蹲在厕所里刷视频',
  '假装在看文件，其实在发呆', '下楼买了杯咖啡，慢慢走了一圈', '在工位上偷偷看了半章小说', '翻外卖软件纠结中午吃什么',
  '对着窗外发了会儿呆', '跟隔壁工位的人传了两句闲话', '去接水，来回走了三趟', '打开购物软件看了会儿衣服',
  '把手机架在抽屉里刷短视频', '假装去打印，在打印机那边站了半天', '在便签上随便画了几笔', '戴上耳机听了一会儿歌',
  '去阳台上站了会儿吹风', '翻了一遍朋友圈，点了几个赞', '靠在椅背上闭了会儿眼', '跟人聊了两句周末的安排',
]

// 放假出门的去处：都在「能出门、当天回得来」的范围里
export const OUTINGS = [
  '去商场逛了一圈', '去公园走了走', '找了家咖啡馆坐了一下午', '去看了场电影',
  '去超市买了点菜', '去书店翻了会儿书', '沿着河边骑了一圈车', '约朋友吃了个饭',
  '去菜市场转了一圈', '去逛了趟文具店', '去美术馆看了一个展', '去面包店买了两个面包',
  '在公园的长椅上坐了一会儿', '去电玩城玩了两把', '去小吃街从头吃到尾', '去花市挑了一盆绿植',
  '去图书馆待了一下午', '去夜市逛了一圈', '去猫咖坐了会儿', '去游泳馆游了几圈',
  '去商场的地下超市囤了点零食', '去老城区随便走了走', '去朋友家坐了一会儿', '去爬山，走到半山腰就下来了',
]

// 谁管她：摸鱼被抓时说话的是这个人
const LEADER = { office: '主管', programmer: '组长', teacher: '年级主任', doctor: '主任', nurse: '护士长', restaurant: '店长', sales: '店长', courier: '站长', security: '队长', factory: '班长', student: '班主任' }
// 管得严的职业：被抓概率更高
const STRICT = new Set(['teacher', 'doctor', 'nurse', 'restaurant', 'security', 'factory', 'courier'])

export const leaderOf = (id) => LEADER[id] || '主管'
export const caughtChance = (id) => (STRICT.has(id) ? 0.2 : 0.08)
export const tasksFor = (id) => WORK_TASKS[id] || WORK_TASKS.office

export const pick = (list, rand = Math.random) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))]

// 抽一条还没出现过的；整池都用过了才允许重样（避免同一天抽到两条一样的活、连着摸同一种鱼）
export const pickFresh = (list, used = [], rand = Math.random) => {
  const fresh = list.filter((x) => !used.includes(x))
  return pick(fresh.length ? fresh : list, rand)
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const minsOf = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes() }

// 一条活：多久要做完、做完算多少进度。avoid 是今天已经出现过的话，先避开它们
export function newTask(profId, now, { rand = Math.random, hours = 3, avoid = [] } = {}) {
  const h = clamp(hours * (0.7 + rand() * 0.6), 0.5, 12)
  return {
    id: `t${now}${Math.floor(rand() * 1000)}`,
    title: pickFresh(tasksFor(profId), avoid, rand),
    at: now,
    deadline: now + Math.round(h * HOUR),
    progress: 0,
    done: false,
    failed: false,
  }
}

// 干一次活推进多少：25%~45%，两次到三次能干完
export function advance(task, rand = Math.random) {
  const gain = 25 + Math.floor(rand() * 21)
  task.progress = Math.min(100, task.progress + gain)
  return task.progress >= 100
}

// 这次是干活还是摸鱼。心情差、压力大更想摸；手上有活儿卡着点就不敢摸。
export function willSlack({ mood = 60, pressure = 0, urgent = false, now = Date.now() } = {}, rand = Math.random) {
  const mins = minsOf(now)
  let p = 0.22
  if (mood < 45) p += 0.12
  if (mood < 35) p += 0.08
  if (pressure >= 60) p += 0.08
  if (urgent) p -= 0.2
  if (mins >= 13 * 60 && mins < 14 * 60 + 30) p += 0.08 // 午饭后最容易走神
  if (mins >= 17 * 60 && mins < 18 * 60) p += 0.06 // 临近收工
  return rand() < clamp(p, 0.04, 0.65)
}

// 休息日要不要出门。心情好、白天更愿意出去；压力大、太早太晚更想窝着。
export function willGoOut({ mood = 60, pressure = 0, now = Date.now() } = {}, rand = Math.random) {
  const mins = minsOf(now)
  let p = 0.45
  if (mood >= 65) p += 0.12
  if (mood < 40) p -= 0.15
  if (pressure >= 65) p -= 0.12
  if (mins < 9 * 60) p -= 0.15
  if (mins >= 20 * 60) p -= 0.22
  return rand() < clamp(p, 0.08, 0.75)
}

export function newOuting(now, { rand = Math.random, recent = [] } = {}) {
  const hours = 1 + rand() * 2.5
  return { act: pickFresh(OUTINGS, recent, rand), from: now, until: now + Math.round(hours * HOUR) }
}

// ---------- 各个决定的说法和后果（面板看 text，发给她主人用 say）----------
export function doWork({ task, rand = Math.random } = {}) {
  if (!task) {
    return { kind: 'work', text: '把手头的活收了收，没什么非做不可的', say: '活不多，慢慢收尾呢', mood: 1, shareable: true }
  }
  const done = advance(task, rand)
  return done
    ? { kind: 'task-done', taskId: task.id, text: `把「${task.title}」做完了`, say: `「${task.title}」终于弄完了`, mood: 5, shareable: true, memory: true }
    : { kind: 'work', taskId: task.id, text: `接着做「${task.title}」，到 ${task.progress}%`, say: `还在跟「${task.title}」较劲`, mood: 1, shareable: true }
}

export function doSlack({ profId = 'office', rand = Math.random, recent = [] } = {}) {
  const caught = rand() < caughtChance(profId)
  if (caught) {
    const who = leaderOf(profId)
    return { kind: 'slack-caught', text: `摸鱼被${who}看见了，说了两句`, say: `刚偷懒被${who}撞见了…`, mood: -6, shareable: true, memory: true }
  }
  // 一次抽定，说的和记的必须是同一件事；最近摸过的先不重样
  const act = pickFresh(SLACKS, recent, rand)
  return { kind: 'slack', text: act, say: act, mood: 2, shareable: true }
}

export function goOut({ outing }) {
  return { kind: 'out', outing, text: `出门了，${outing.act}`, say: `出来${outing.act.replace(/^去/, '')}`, mood: 2, shareable: true }
}

export function backHome({ outing }) {
  return { kind: 'out-back', outgoing: outing, text: `${outing.act}，回来了`, say: `回来了，${outing.act.replace(/^去/, '')}`, mood: 3, shareable: true, memory: true }
}

export function stayHome({ now = Date.now() } = {}) {
  const h = new Date(now).getHours()
  const late = h >= 20
  return { kind: 'home', text: late ? '今天不出去了，晚上在家待着' : '今天不出门，在家待着', say: '今天不出去啦，在家', mood: 0, shareable: true }
}

export function taskFailed({ task, profId = 'office' }) {
  const who = leaderOf(profId)
  return { kind: 'task-failed', taskId: task.id, text: `「${task.title}」没按时做完，被${who}说了一顿`, say: `「${task.title}」拖过头了，被${who}说了`, mood: -8, shareable: true, memory: true }
}
