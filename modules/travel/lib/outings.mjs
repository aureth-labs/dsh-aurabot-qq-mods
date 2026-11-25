// 出门走走（用户模块） v1.5.0 —— 给她屋子外面的世界
//
// 这一版给的是「活动」而不只是「地点」：
//   1) 本地点位：成都真实的十五个地方（合江亭、玉林菜市场、人民公园、太古里、建设巷、青龙湖、龙泉山……）
//   2) 出门活动：爬山、看海、露营、旅游、古镇、温泉、骑行、钓鱼——每个活动带几个真实目的地
//   3) 天时按「她现在所在的那个地方」算：那里的经纬度 → 日出日落、时区、季节、天气
//      天气（高德实况优先，没 key 才退回 open-meteo）只在「有人问天气 / 出门 / 到达新地点」时去拉，平时读缓存
//   4) 定位优先用「真实定位卡片」模块里主人授权过的真实位置；没有授权才退回点位坐标
//   5) 面板（panel.js）：她现在在哪、天时、活动清单、派遣出发、回家、发定位、抓实景
//
// 设计上的几条线，都是踩过的坑：
//   - 天时必须是「所在地」的，不是成都的。以前她在都江堰也说成都的日落，对不上。
//   - 日落/夜市/花这几类句子跟时间绑死，不合时令整句丢掉，宁可说天气本身。
//   - 出门是她自己的事，不用请示；旅游这种远门一天算一趟，别一天跑三趟三亚。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOME = 'home'
const TZ = 8 // 一律按北京时间判定，不看机器时区

// ---------- 本地点位（成都） ----------
// mins 是单程大概花多久；travel 是怎么去；scene 是拍照时的画面底子；
// events 是到了之后会碰上什么；realDetail 是那个地方真实的地标细节，比泛写的更有贴地感。
const SPOTS = [
  {
    id: 'home', name: '家', kind: 'home', mins: 0, travel: '',
    lat: 30.6570, lon: 104.0657, addr: '四川省成都市 青羊区 某小区（示例，可在 places 里改）',
    scene: '屋里，暖黄的灯，桌上有没收的杯子',
    things: ['泡杯茶', '把衣服叠了', '在窗边坐一会儿'],
    events: ['窗外有人在楼下说话', '楼下飘上来一点炒菜的味'],
  },
  {
    id: 'lane', name: '楼下', kind: 'near', mins: 3, travel: '穿着拖鞋下楼',
    lat: 30.6569, lon: 104.0659, addr: '四川省成都市 青羊区 小区门口（示例）',
    photo: '成都 老小区 楼下 街景',
    scene: '小区楼下的空地，路灯、绿化带、几辆停着的电动车',
    things: ['绕着楼走一圈', '看看谁家阳台晾了什么', '蹲下逗一下楼下的猫'],
    events: [
      '楼下那只橘猫蹲在电动车座上，见人也不跑，只是尾巴甩了一下',
      '有个阿姨拎着两袋菜上楼，袋子底下滴水，一路滴到楼道口',
      '一阵风吹过来，树叶哗啦响，楼上有人把窗户关上了',
      '快递员把车停在门口，一边打电话一边翻后备箱',
    ],
    realDetail: [
      '小区门口那棵黄葛树叶子还是绿的，树下停了一排电动车',
      '门卫室的窗户开着，里面收音机在放川剧',
    ],
  },
  {
    id: 'garden', name: '小区花园', kind: 'near', mins: 6, travel: '慢慢走过去',
    lat: 30.6567, lon: 104.0655, addr: '四川省成都市 青羊区 小区中庭（示例）',
    photo: '成都 小区 中庭 绿化',
    scene: '小区花园，矮灌木、长椅、几棵开花的树',
    things: ['坐在长椅上发呆', '看看花开了没有', '听小孩在玩什么'],
    events: [
      '长椅上落了半片树影，坐着的时候有小孩在旁边追着跑',
      '灌木丛里有只鸟跳来跳去，叫得挺急',
      '有人推着婴儿车过来，车轮在砖缝里咯噔了一下',
      '花坛边的水管没关紧，一直在滴水',
    ],
    realDetail: ['中庭的长椅上摊着一床被子在晒', '几个小孩在喷泉边上追，鞋都跑掉了'],
  },
  {
    id: 'store', name: '便利店', kind: 'near', mins: 8, travel: '走过去',
    lat: 30.6565, lon: 104.0663, addr: '四川省成都市 青羊区 便利店（示例）',
    photo: '成都 红旗连锁 便利店 门口',
    scene: '便利店门口，玻璃门、货架、门口的灯箱',
    things: ['买瓶水', '看看关东煮还剩什么', '在门口吹会儿空调'],
    events: [
      '关东煮的汤在冒小泡，萝卜已经煮得发黄了',
      '店员在补货，纸箱拆开的声音很脆',
      '有个学生买了一支雪糕，站在门口吃完才走',
      '门口的灯箱闪了一下，又亮起来',
    ],
    realDetail: ['店里在放川话版的促销广播', '收银台前面摞着一箱一箱的牛奶'],
  },
  {
    id: 'market', name: '菜市场', kind: 'mid', mins: 15, travel: '骑共享单车',
    lat: 30.6300, lon: 104.0620, addr: '四川省成都市 武侯区 玉林',
    photo: '成都 玉林 菜市场 实拍', wiki: 'Yulin Chengdu', kw: /玉林|菜市场/,
    scene: '菜市场，湿漉漉的地面、堆起来的菜、塑料棚的灯',
    things: ['挑几个番茄', '买一把小葱', '看看今天什么鱼新鲜'],
    events: [
      '卖鱼的摊子前面全是水，老板拿刀背拍了一下鱼，声音闷闷的',
      '有个摊主在吆喝最后两把青菜，五块钱两把',
      '地上有一片踩烂的菜叶，走路得绕开',
      '旁边有人为了两毛钱跟摊主讲了半天价',
      '棚顶的灯管有一根在闪，照得豆腐白得发亮',
    ],
    realDetail: [
      '摊子上摆着扎好的豌豆尖，叶子还带着水',
      '卤菜窗口在排队，鸭脖切得飞快',
      '卖鱼的老板一开口就是成都话，尾音拖得很长',
    ],
  },
  {
    id: 'super', name: '超市', kind: 'mid', mins: 15, travel: '走过去',
    lat: 30.6320, lon: 104.0600, addr: '四川省成都市 武侯区 玉林 永辉',
    photo: '成都 永辉超市 生鲜区',
    scene: '超市里，整齐的货架、冷柜的白光、推车',
    things: ['拿一盒牛奶', '在零食区转两圈', '看看有没有打折'],
    events: [
      '冷柜的风直往腿上吹，站久了有点凉',
      '广播在念今天的特价，声音有点糊',
      '有个小孩坐在推车里，被妈妈推着走，一路晃腿',
      '试吃台前排了三个人，都是冲着那盘切好的水果',
    ],
    realDetail: ['生鲜区的水雾一直在喷，菜叶上全是水珠'],
  },
  {
    id: 'cafe', name: '咖啡馆', kind: 'mid', mins: 20, travel: '骑车过去',
    lat: 30.6290, lon: 104.0605, addr: '四川省成都市 武侯区 玉林',
    photo: '成都 玉林 咖啡馆 街边', wiki: 'Yulin Chengdu', kw: /玉林|咖啡馆|小酒馆/,
    scene: '咖啡馆靠窗的位置，木桌、杯子、窗外的街',
    things: ['点一杯热的', '坐窗边看外面', '听旁边桌在聊什么'],
    events: [
      '磨豆机响了一阵，整间店都是那股焦香',
      '隔壁桌两个人在改方案，一直在说「这个逻辑不对」',
      '窗外的公交车过去，玻璃震了一下',
      '杯子放在桌上，热气把窗子糊了一小片白',
    ],
    realDetail: ['隔壁就是小酒馆那条街，白天安静得很', '店门口的塑料椅子被太阳晒得发烫'],
  },
  {
    id: 'book', name: '书店', kind: 'mid', mins: 20, travel: '骑车过去',
    lat: 30.6516, lon: 104.0806, addr: '四川省成都市 锦江区 太古里 方所',
    photo: '成都 方所 书店 内部', wiki: 'Sino-Ocean Taikoo Li Chengdu', kw: /方所|太古里/,
    scene: '书店，书架、翻开的书、安静的光',
    things: ['翻一本画册', '找找有没有喜欢的封面', '在角落里坐一会儿'],
    events: [
      '有人把书放回架子，位置放错了，店员过去理了一下',
      '画册那一页印得很厚，纸摸起来有点粗',
      '店里放着很轻的音乐，几乎听不清旋律',
      '有个小孩趴在地上看书，家长在旁边小声催',
    ],
    realDetail: ['那条下沉的长坡两边全是书，灯压得很低', '有人在坡道上坐了一下午，书翻到一半就睡了'],
  },
  {
    id: 'mall', name: '商场', kind: 'mid', mins: 25, travel: '坐地铁两站',
    lat: 30.6519, lon: 104.0810, addr: '四川省成都市 锦江区 中纱帽街',
    photo: '成都 太古里 街景 实拍', wiki: 'Sino-Ocean Taikoo Li Chengdu', kw: /太古里|大慈寺|春熙/,
    scene: '商场里，亮着的橱窗、扶梯、来往的人',
    things: ['逛两层看看', '试一件衣服', '在顶层看看电影排片'],
    events: [
      '扶梯上有人拖着行李箱，轮子在梯级上卡了一下',
      '橱窗里的模特换了新一季的衣服，颜色很跳',
      '中庭有人在搭活动台，音箱一直试音',
      '奶茶店排了长队，叫号的声音一遍一遍',
    ],
    realDetail: [
      '大慈寺的红墙就在商场后面，隔一条街就是玻璃幕墙',
      '裸眼 3D 大屏在放广告，路人全抬头看',
      '穿汉服拍照的人一队一队从青石板上过去',
    ],
  },
  {
    id: 'river', name: '河边', kind: 'mid', mins: 30, travel: '骑车沿江过去',
    lat: 30.6487, lon: 104.0866, addr: '四川省成都市 锦江区 合江亭',
    photo: '成都 合江亭 锦江 河边 实拍', wiki: 'Hejiang Pavilion', kw: /合江亭|锦江|廊桥|安顺/,
    scene: '河边步道，水面反光、护栏、远处的桥',
    things: ['沿步道走一段', '靠在栏杆上看水', '在石阶上坐会儿'],
    events: [
      '水面被风推出一层细纹，光在上面碎成一片一片',
      '有人在下游钓鱼，鱼竿一直架着没动',
      '跑步的人从背后过去，鞋底在塑胶道上蹭出声',
      '桥下有一群人在拍日落，手机举得很齐',
      '水里飘过来一片叶子，转了两圈又走了',
    ],
    realDetail: [
      '两条江在这儿汇到一起，栏杆上有人趴着看水',
      '对岸锦江边的灯带一节一节亮着',
      '桥洞底下有回音，走过去脚步声特别响',
      '河边的石阶上坐着两个钓鱼的，桶里没几条',
    ],
  },
  {
    id: 'park', name: '公园', kind: 'mid', mins: 30, travel: '走过去',
    lat: 30.6605, lon: 104.0620, addr: '四川省成都市 青羊区 少城路',
    photo: '成都 人民公园 鹤鸣茶社 实拍', wiki: 'Peoples Park Chengdu', kw: /人民公园|鹤鸣|少城/,
    scene: '公园，草地、树荫、长椅和来遛弯的人',
    things: ['找片树荫坐着', '看别人打太极', '绕湖走一圈'],
    events: [
      '草地上有人在放风筝，线拉得很紧，风筝一直抖',
      '树荫下有个大爷在拉二胡，拉的调子跑了一点',
      '一只狗跑过来闻了闻，又被主人叫回去了',
      '卖冰粉的小车停在路口，喇叭循环着同一句',
      '风把一片叶子吹到鞋面上，又滑下去',
    ],
    realDetail: [
      '鹤鸣茶社那边一片竹椅子，盖碗茶摆满桌',
      '有人拿长夹子给人掏耳朵，动静很小',
      '相亲角那边贴了一排 A4 纸，被风吹得直翻',
      '湖上有划船的，船桨在水里搅出很闷的声音',
    ],
  },
  {
    id: 'cinema', name: '电影院', kind: 'mid', mins: 30, travel: '坐地铁过去',
    lat: 30.6580, lon: 104.0700, addr: '四川省成都市 青羊区 影院',
    photo: '成都 电影院 大厅 海报墙',
    scene: '电影院大厅，海报墙、取票机、暗下来的厅',
    things: ['挑一场看', '买小份爆米花', '在海报墙前站一会儿'],
    events: [
      '取票机吐票的声音很轻，纸从缝里一点点出来',
      '影厅里的人还在聊，灯一暗就安静了',
      '爆米花桶放在腿上，热气把盖子糊了一层',
      '散场时人往外涌，走廊的灯照得有点晃眼',
    ],
    realDetail: ['取票机旁边贴满了海报，边角被摸得发亮'],
  },
  {
    id: 'night', name: '夜市', kind: 'mid', mins: 35, travel: '骑车过去',
    lat: 30.6788, lon: 104.0996, addr: '四川省成都市 成华区 建设巷',
    photo: '成都 建设巷 小吃街 夜景', wiki: 'Jianshe Road Chengdu', kw: /建设巷|建设路/,
    scene: '夜市，油烟、串灯、挤在一起的小摊',
    things: ['买一份烤的', '看看有什么没见过的', '在人流里慢慢走'],
    events: [
      '铁板上的油一响，香味整条街都是',
      '摊主一边翻串一边跟熟客打招呼',
      '串灯有一串接触不良，一闪一闪',
      '有人在前面拍照，把后面的路堵了一小块',
      '手上沾了一点辣油，纸袋也油了',
    ],
    realDetail: [
      '电子科大这边的学生排队买烤脑花',
      '铁板鱿鱼的油星子溅到围裙上',
      '整条巷子油烟糊成一片，抬头看灯都是毛的',
    ],
  },
  {
    id: 'lake', name: '湖边', kind: 'far', mins: 70, travel: '坐公交到终点再走一段',
    lat: 30.6090, lon: 104.2100, addr: '四川省成都市 成华区 青龙湖湿地',
    photo: '成都 青龙湖 湿地 芦苇 实拍', kw: /青龙湖/,
    scene: '湖边，开阔的水面、芦苇、远处的山影',
    things: ['沿湖走一段', '找块石头坐着', '看水面上的光'],
    events: [
      '风从水面过来，带着一点湿凉',
      '芦苇丛里有水鸟突然起飞，翅膀拍了两下',
      '有人在栈桥上坐着不走，一直看着对面',
      '水面上有条船慢慢过去，尾迹散了很久才平',
    ],
    realDetail: [
      '环湖绿道上有人骑车，铃铛一路响',
      '芦苇比人还高，走过去沙沙地刮衣服',
      '水面上有成群的白鹭，一有人靠近就整片飞起来',
    ],
  },
  {
    id: 'mountain', name: '山上', kind: 'far', mins: 90, travel: '坐车到山脚，再走上去',
    lat: 30.5420, lon: 104.2900, addr: '四川省成都市 龙泉驿区 龙泉山观景台',
    photo: '成都 龙泉山 观景台 俯瞰', kw: /龙泉山/,
    scene: '山道上，树影、石阶、雾气、远处的山脊',
    things: ['慢慢往上走', '在半山腰歇一会儿', '看看山下的城'],
    events: [
      '石阶上有一层薄薄的湿，踩上去有点滑',
      '树林里一直在响，说不清是风还是虫',
      '有队人背着包超过去，喘得很重',
      '走到开阔处，山下那片楼顶全在雾里',
      '手扶着栏杆往上走，掌心被磨得有点热',
    ],
    realDetail: [
      '观景台上能看见整片成都的灯，一层一层的铺到天边',
      '山上比城里凉好几度，风直接灌进领口',
      '骑行的人一队一队从盘山路上来，全在护栏边歇着',
    ],
  },
  {
    id: 'sea', name: '都江堰', kind: 'far', mins: 180, travel: '坐高铁再转一段车',
    lat: 31.0020, lon: 103.5770, addr: '四川省成都市 都江堰 南桥',
    photo: '都江堰 南桥 夜景 实拍', wiki: 'Dujiangyan', kw: /都江堰|南桥|鱼嘴|灌县/,
    scene: '南桥边的江面，白浪、古城石板、远处的山',
    things: ['在南桥上站一会儿', '沿古城街走一段', '听桥底下的水声'],
    events: [
      '桥底下的水声轰得很，说话都得抬高音量',
      '江边的风带着水汽，吹久了衣服有点潮',
      '石板路被走得发亮，鞋底蹭上去有点滑',
      '远处山上的云压得很低，像要下雨',
    ],
    realDetail: [
      '南桥上的灯是蓝的，桥底下水声轰得很',
      '鱼嘴那边水被劈成两股，白浪一路翻出来',
      '古城那条街的石板被磨得很亮，两边全是小吃摊',
    ],
  },
]

// ---------- 出门活动 ----------
// 活动是「出去干什么」，每个活动带几个真实目的地。days=0 表示当天回；>0 表示要在外住几晚。
// 目的地的经纬度是查出来的真实坐标，差几十米正常。
const ACTS = {
  hike: {
    name: '爬山', kind: 'far', travel: '坐车到山脚，再走上去', mins: 100, days: 0,
    intro: '换个高度待着，山里的风跟城里不一样',
    dests: [
      {
        id: 'qingcheng', name: '青城山', lat: 30.9022, lon: 103.5670, addr: '四川省成都市 都江堰市 青城山镇',
        photo: '青城山 山道 道观 实拍', wiki: 'Mount Qingcheng', kw: /青城山/,
        scene: '青城山的石阶，树荫很密、道观的红墙、雾从谷底上来',
        things: ['沿石阶往上走', '在道观门口坐一会儿', '听山涧的水声'],
        events: [
          '石阶两边全是苔，踩上去软软的',
          '道观里的香一直在烧，烟直直地往上',
          '有挑山工背着东西下来，步子比谁都快',
          '雾从谷底漫上来，十几米外的树就看不见了',
        ],
      },
      {
        id: 'emei', name: '峨眉山', lat: 29.6013, lon: 103.3343, addr: '四川省乐山市 峨眉山市 黄湾乡',
        photo: '峨眉山 金顶 云海 实拍', wiki: 'Mount Emei', kw: /峨眉山/,
        scene: '峨眉山的盘山路，云雾、松林、远处的金顶',
        things: ['慢慢往金顶走', '在观景台看云海', '找只猴子远远看着'],
        events: [
          '云在脚下翻，山脊从云里露出来一截',
          '猴子蹲在栏杆上盯人的口袋，谁都不敢动',
          '山上比山下冷一大截，呼出来的气是白的',
          '有人在上头喊了一声，回音绕了两圈',
        ],
      },
      {
        id: 'longquan', name: '龙泉山', lat: 30.5420, lon: 104.2900, addr: '四川省成都市 龙泉驿区 龙泉山观景台',
        photo: '成都 龙泉山 观景台 俯瞰', kw: /龙泉山/,
        scene: '龙泉山的观景台，山脊、盘山路、下面的城',
        things: ['在观景台看城', '沿盘山路走一段', '找个背风的地方坐'],
        events: [
          '整片成都的楼在下面铺开，一直铺到看不见的地方',
          '风从山脊上灌下来，衣服都贴在身上',
          '骑行的人一队队上来，全在护栏边喝水',
          '太阳落到楼的后面，天边剩一条橘色',
        ],
      },
    ],
  },
  sea: {
    name: '看海', kind: 'trip', travel: '飞机/高铁过去', mins: 300, days: 2,
    intro: '真海，不是湖。海风、浪声、一整条海平线',
    dests: [
      {
        id: 'beihai', name: '北海银滩', lat: 21.4380, lon: 109.1470, addr: '广西壮族自治区 北海市 银海区 银滩',
        photo: '北海银滩 海边 实拍', wiki: 'Beihai Silver Beach', kw: /北海|银滩/,
        scene: '银滩的沙滩，细白的沙、一层层白浪、远处的海平线',
        things: ['脱鞋踩水', '沿沙滩走一段', '坐在堤上看海'],
        events: [
          '沙细得像面粉，脚踩下去会陷一点',
          '浪退下去的时候，沙子在脚底下响',
          '海风把头发全吹乱了，只能一直用手按',
          '远处有渔船，小得只剩一个点',
        ],
      },
      {
        id: 'xiamen', name: '厦门鼓浪屿', lat: 24.4470, lon: 118.0670, addr: '福建省厦门市 思明区 鼓浪屿',
        photo: '厦门 鼓浪屿 海边 实拍', wiki: 'Gulangyu', kw: /鼓浪屿|厦门/,
        scene: '鼓浪屿的海边小路，老别墅、凤凰木、海在巷子尽头',
        things: ['沿环岛小路走', '在礁石边坐一会儿', '看对岸的楼'],
        events: [
          '巷子尽头突然就是海，风从那边灌进来',
          '老别墅的窗子半开着，里面有人在弹琴',
          '礁石上有寄居蟹，一动就缩回去',
          '渡船靠岸，人一下子涌出来',
        ],
      },
      {
        id: 'qingdao', name: '青岛栈桥', lat: 36.0600, lon: 120.3140, addr: '山东省青岛市 市南区 太平路',
        photo: '青岛 栈桥 海边 实拍', wiki: 'Zhanqiao Pier', kw: /栈桥|青岛/,
        scene: '青岛的海湾，栈桥伸进海里、红瓦屋顶、海雾',
        things: ['走到栈桥尽头', '在海边石阶上坐', '看人钓鱼'],
        events: [
          '栈桥尽头的回澜阁，风大得站不稳',
          '海边有人拿长竿钓鱼，线甩得很远',
          '海雾压下来，远处的船只剩影子',
          '礁石上全是海蛎子的壳，走上去咯吱响',
        ],
      },
    ],
  },
  camp: {
    name: '露营', kind: 'mid', travel: '开车/坐车过去', mins: 100, days: 1,
    intro: '搭个帐篷，把一晚过成两段：天黑前和天黑后',
    dests: [
      {
        id: 'hongkou', name: '都江堰虹口', lat: 31.1040, lon: 103.6180, addr: '四川省成都市 都江堰市 虹口乡',
        photo: '都江堰 虹口 露营 河滩 实拍', kw: /虹口/,
        scene: '虹口的河滩，帐篷、卵石、两岸的山和竹林',
        things: ['把帐篷支起来', '在河边捡石头', '等天黑点灯'],
        events: [
          '河水声一直在，说话得靠近一点才听得清',
          '帐篷杆穿到一半卡住了，抖了两下才通',
          '隔壁营地在烤肉，烟顺着风飘过来',
          '天黑了以后，山那边一颗星一颗星亮起来',
        ],
      },
      {
        id: 'bailu', name: '彭州白鹿镇', lat: 31.1900, lon: 103.8300, addr: '四川省成都市 彭州市 白鹿镇',
        photo: '彭州 白鹿 露营 山谷 实拍', kw: /白鹿/,
        scene: '白鹿的山谷营地，草地、法式小教堂、四面是山',
        things: ['在草地上铺开垫子', '去教堂那边走一圈', '晚上听山谷的风'],
        events: [
          '山谷里的风到夜里会变大，帐篷布一直响',
          '教堂的钟敲了一下，声音在山里绕很久',
          '草地上的露水到半夜就起来了，鞋面全是湿的',
          '有人在远处弹吉他，调子听不太清',
        ],
      },
    ],
  },
  trip: {
    name: '旅游', kind: 'trip', travel: '高铁/飞机过去', mins: 240, days: 3,
    intro: '去一个不在成都的城市待几天，走街、吃饭、看当地人怎么过',
    dests: [
      {
        id: 'chongqing', name: '重庆', lat: 29.5580, lon: 106.5770, addr: '重庆市 渝中区 解放碑',
        photo: '重庆 解放碑 洪崖洞 夜景 实拍', wiki: 'Chongqing', kw: /重庆|解放碑|洪崖洞/,
        scene: '重庆的坡道和台阶，江雾、轻轨、楼叠着楼',
        things: ['沿坡道往下走', '在小面馆吃一碗', '晚上看江对面的灯'],
        events: [
          '导航说到了，抬头发现目的地在头顶六层',
          '轻轨从楼里穿过去，窗户里全是人头',
          '小面馆的老板问要不要加辣，问得很认真',
          '江雾起来，对岸的灯只剩一团一团的光',
        ],
      },
      {
        id: 'xian', name: '西安', lat: 34.2610, lon: 108.9420, addr: '陕西省西安市 碑林区 钟楼',
        photo: '西安 城墙 钟楼 实拍', wiki: 'Xian City Wall', kw: /西安|城墙|钟楼/,
        scene: '西安的城墙根，砖墙、护城河、骑车的人',
        things: ['沿城墙走一段', '在回民街吃一圈', '看钟楼亮灯'],
        events: [
          '城墙上的砖被摸得发亮，缝里长着草',
          '回民街的烟一直没断，队伍排到巷口',
          '钟楼亮灯的那一刻，一圈人举起手机',
          '护城河的水很静，倒影比实景清楚',
        ],
      },
      {
        id: 'dali', name: '大理', lat: 25.6060, lon: 100.2670, addr: '云南省大理市 大理古城',
        photo: '大理 洱海 古城 实拍', wiki: 'Dali Yunnan', kw: /大理|洱海/,
        scene: '大理古城的石板路，白墙、洱海、苍山的云',
        things: ['沿洱海骑一段', '在古城里转小巷', '找个院子坐一下午'],
        events: [
          '洱海边的风一直往岸上推，帽子差点飞走',
          '古城里的小巷很窄，两边全是院门',
          '苍山的云压在山腰，一直没散',
          '有人牵着马在街上走，铃铛一路响',
        ],
      },
      {
        id: 'sanya', name: '三亚', lat: 18.2520, lon: 109.5120, addr: '海南省三亚市 吉阳区 大东海',
        photo: '三亚 海边 椰林 实拍', wiki: 'Sanya', kw: /三亚|大东海/,
        scene: '三亚的海湾，椰子树、白沙滩、晒得发烫的石头',
        things: ['下海泡一会儿', '在椰子树下躺着', '傍晚沿海边走'],
        events: [
          '海水比想象中暖，上岸风一吹反而凉',
          '沙滩上的石头晒得烫脚，只能跳着走',
          '椰子摊的老板一刀削开，插根吸管递过来',
          '傍晚的海面反着光，人的影子拉得很长',
        ],
      },
    ],
  },
  oldtown: {
    name: '古镇', kind: 'mid', travel: '坐车过去', mins: 60, days: 0,
    intro: '一条老街、一条河、几个卖小吃的摊',
    dests: [
      {
        id: 'huanglongxi', name: '黄龙溪', lat: 30.3240, lon: 103.9730, addr: '四川省成都市 双流区 黄龙溪镇',
        photo: '成都 黄龙溪 古镇 实拍', kw: /黄龙溪/,
        scene: '黄龙溪的老街，青石板、溪水、两边的小摊',
        things: ['沿溪走到桥头', '买一份小吃', '坐在廊桥下歇'],
        events: [
          '溪水从街中间穿过去，石头被冲得发白',
          '卖伤心凉粉的摊前排着队，辣油红得很亮',
          '老房子的木头有一股潮湿的味',
          '廊桥底下有人在打牌，声音很散',
        ],
      },
      {
        id: 'luodai', name: '洛带古镇', lat: 30.6440, lon: 104.4100, addr: '四川省成都市 龙泉驿区 洛带镇',
        photo: '成都 洛带 古镇 实拍', kw: /洛带/,
        scene: '洛带的客家老街，会馆、土楼、石板路',
        things: ['逛会馆', '吃一碗客家面', '在土楼前拍照'],
        events: [
          '会馆里的戏台空着，椅子摆得很齐',
          '街边的客家面馆只有三口锅，一直在冒气',
          '土楼的墙是圆的，走一圈刚好一支烟',
          '有人挑着担子卖糍粑，锤子敲得很响',
        ],
      },
    ],
  },
  spring: {
    name: '温泉', kind: 'mid', travel: '坐车过去', mins: 90, days: 1,
    intro: '泡在热水里，把一整天的凉气焐出去',
    dests: [
      {
        id: 'huashuiwan', name: '花水湾温泉', lat: 30.8060, lon: 103.2560, addr: '四川省成都市 大邑县 花水湾镇',
        photo: '花水湾 温泉 山间 实拍', kw: /花水湾/,
        scene: '花水湾的山里温泉，池子冒着白汽、四周是竹林',
        things: ['泡一会儿', '在走廊上吹风', '裹着毛巾坐一下'],
        events: [
          '池边的白汽一层一层往上，看不清对面的人',
          '从热水里出来，山里的风一下就贴到皮肤上',
          '有人泡完就躺在躺椅上不动了',
          '竹林里的水一直在滴，落在石板上很轻',
        ],
      },
    ],
  },
  ride: {
    name: '骑行', kind: 'mid', travel: '推车出门', mins: 40, days: 0,
    intro: '沿着绿道骑一段，风是自己挣来的',
    dests: [
      {
        id: 'greenway', name: '锦江绿道', lat: 30.6400, lon: 104.0900, addr: '四川省成都市 锦江区 锦江绿道',
        photo: '成都 锦江绿道 骑行 实拍', kw: /锦江|绿道/,
        scene: '锦江绿道，河在一边、树在一边、路面很平',
        things: ['骑到下一个桥', '在驿站停一下', '靠着栏杆喝口水'],
        events: [
          '前面一队人骑得很快，铃铛一路响',
          '绿道边上的树影一格一格从身上过去',
          '驿站的自动贩卖机只剩两瓶水',
          '骑到桥上，江风一下把汗吹凉了',
        ],
      },
    ],
  },
  fish: {
    name: '钓鱼', kind: 'mid', travel: '带着竿过去', mins: 35, days: 0,
    intro: '坐在水边等，等不到也算过了一天',
    dests: [
      {
        id: 'jinjiang', name: '锦江边', lat: 30.6487, lon: 104.0866, addr: '四川省成都市 锦江区 合江亭',
        photo: '成都 合江亭 锦江 河边 实拍', kw: /合江亭|锦江/,
        scene: '锦江边的石阶，水、竿、对面的人',
        things: ['把竿架好', '坐着等', '换一次饵'],
        events: [
          '浮漂动了一下，提竿是空的',
          '旁边的老大爷一句话不说，桶里已经有两条',
          '水面上的光一晃一晃，看久了有点困',
          '有船过去，浪把浮漂推得乱晃',
        ],
      },
    ],
  },
}

const HOME_SPOT = SPOTS[0]
const byId = (id) => SPOTS.find((p) => p.id === id) || null
const pickOne = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '')
const pad = (n) => (n < 10 ? '0' : '') + n
const minsSince = (ts) => Math.max(0, Math.round((Date.now() - ts) / 60000))
const HOW_LONG = (m) => (m < 1 ? '刚出门' : m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`)

// ---------- 天时：按「所在地」算 ----------
// 以前这里是写死的成都经纬度，人跑到都江堰、三亚还说成都的日落。现在所有计算都吃地点的坐标。
function bj(ts = Date.now()) {
  const d = new Date(Number(ts) + TZ * 3600_000)
  return {
    ms: d.getTime(),
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}
const bjText = (ts) => { const t = bj(ts); return `${pad(t.hh)}:${pad(t.mm)}` }
const bjDay = (ts = Date.now()) => { const t = bj(ts); return `${t.y}-${pad(t.m)}-${pad(t.d)}` }

/** 某地某天的日出日落（分钟，北京时间）。只算赤纬，误差几分钟，判定「黑没黑」够了。 */
function sunTimes(lat, lon, ts = Date.now()) {
  const t = bj(ts)
  const doy = Math.floor((Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(t.y, 0, 1)) / 86400_000) + 1
  const decl = (-23.44 * Math.cos((2 * Math.PI * (doy + 10)) / 365)) * Math.PI / 180
  const latR = (Number(lat) || 30) * Math.PI / 180
  const cosH = -Math.tan(latR) * Math.tan(decl)
  const H = Math.acos(Math.min(1, Math.max(-1, cosH))) * 180 / Math.PI
  const noon = 12 + ((TZ * 15 - (Number(lon) || 104)) / 15)
  return {
    sunrise: Math.round((noon - H / 15) * 60),
    sunset: Math.round((noon + H / 15) * 60),
    noon: Math.round(noon * 60),
  }
}
const hhmm = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

function phaseOf(spot, ts = Date.now()) {
  const t = bj(ts)
  const s = sunTimes(spot?.lat, spot?.lon, ts)
  const m = t.minutes
  if (m < s.sunrise - 40) return '夜里'
  if (m < s.sunrise + 90) return '清晨'
  if (m < s.noon - 30) return '上午'
  if (m < s.noon + 60) return '中午'
  if (m < s.sunset - 90) return '下午'
  if (m <= s.sunset + 35) return '傍晚'
  return '夜里'
}
function isDark(spot, ts = Date.now()) {
  const m = bj(ts).minutes
  const s = sunTimes(spot?.lat, spot?.lon, ts)
  return m < s.sunrise - 40 || m > s.sunset + 35
}
const seasonOf = (ts = Date.now()) => {
  const mo = bj(ts).m
  if (mo >= 3 && mo <= 5) return '春天'
  if (mo >= 6 && mo <= 8) return '夏天'
  if (mo >= 9 && mo <= 11) return '秋天'
  return '冬天'
}

function weatherWord(code, temp) {
  if (code === 0) return '晴'
  if (code === 1) return '晴间多云'
  if (code === 2) return '多云'
  if (code === 3) return '阴'
  if (code === 45 || code === 48) return '有雾'
  if (code >= 51 && code <= 57) return '毛毛雨'
  if (code >= 61 && code <= 67) return '下雨'
  if (code >= 71 && code <= 77) return '下雪'
  if (code >= 80 && code <= 82) return '阵雨'
  if (code >= 95) return '雷雨'
  return typeof temp === 'number' ? `气温 ${Math.round(temp)}℃` : ''
}

const skyCache = new Map() // key: 经纬度取整 → { at, data }
const SKY_TTL = 15 * 60_000

/** 某地现在什么天：同步算时间/日出日落/季节，天气读缓存，没有就按纬度+月份估（标明是估的） */
function skyNow(spot, ts = Date.now()) {
  const lat = Number(spot?.lat) || 30.57
  const lon = Number(spot?.lon) || 104.07
  const sun = sunTimes(lat, lon, ts)
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`
  const fresh = skyCache.get(key)
  const base = {
    now: bjText(ts),
    phase: phaseOf(spot, ts),
    dark: isDark(spot, ts),
    sunrise: hhmm(sun.sunrise),
    sunset: hhmm(sun.sunset),
    season: seasonOf(ts),
    month: bj(ts).m,
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
  }
  if (fresh) return { ...base, ...fresh.data, ageMinute: Math.max(0, Math.round((Date.now() - fresh.at) / 60_000)) }
  // 估：低纬度更热，高纬度更冷；夏天热，冬天凉
  const mo = base.month
  const warm = lat <= 23 ? 4 : lat <= 26 ? 3 : lat <= 30 ? 2 : lat <= 34 ? 1 : 0
  const summer = mo >= 5 && mo <= 9
  const winter = mo === 12 || mo === 1 || mo === 2
  const temp = summer ? 24 + warm * 3 : winter ? 6 + warm * 3 : 17 + warm * 3
  return {
    ...base,
    word: summer ? '多云' : winter ? '阴' : '多云',
    temp,
    wind: '风不大',
    wet: false,
    estimated: true,
  }
}

/** 高德 key：合并后的 ext.travel.real_amapKey 优先，旧 ext['real-loc'] 兼容回退 */
function amapKeyOf(api) {
  const ext = api?.config?.()?.ext || {}
  const t = ext.travel || {}
  const old = ext['real-loc'] || {}
  return String(t.real_amapKey || '').trim() || String(old.amapKey || '').trim()
    || String(t.real_amapKeyBackup || '').trim() || String(old.amapKeyBackup || '').trim()
}

const adcodeCache = new Map()

/** 经纬度 → adcode（高德行政区编码），同一个点只反查一次 */
async function amapAdcode(lat, lon, key) {
  const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`
  const hit = adcodeCache.get(cacheKey)
  if (hit) return hit
  const url = 'https://restapi.amap.com/v3/geocode/regeo'
    + `?location=${lon.toFixed(6)},${lat.toFixed(6)}&key=${key}&radius=1000&extensions=base`
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`高德反查 ${res.status}`)
  const j = await res.json()
  if (String(j?.status) !== '1') throw new Error(`高德反查 ${j?.info || '没状态'}`)
  const code = String(j?.regeocode?.addressComponent?.adcode || '')
  if (!code || code === '[]') throw new Error('高德没给 adcode')
  adcodeCache.set(cacheKey, code)
  return code
}

/** 高德实况天气；失败就留着季节估，不挡任何事 */
async function amapSky(lat, lon, key) {
  const code = await amapAdcode(lat, lon, key)
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?city=${code}&key=${key}&extensions=base`
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`天气接口 ${res.status}`)
  const j = await res.json()
  if (String(j?.status) !== '1') throw new Error(`天气接口 ${j?.info || '没状态'}`)
  const live = (j?.lives || [])[0]
  if (!live) throw new Error('天气接口没数据')
  const temp = Number(live.temperature)
  const power = String(live.windpower || '').split('|').pop()
  const level = Number(power)
  const word = String(live.weather || '').trim() || '多云'
  return {
    word,
    temp: Number.isFinite(temp) ? Math.round(temp) : null,
    felt: null,
    wind: Number.isFinite(level) && level >= 5 ? '风有点大' : '风不大',
    wet: /雨|雪|雷|冰雹|雾|霾/.test(word),
    humidity: String(live.humidity || '').trim(),
    reportTime: String(live.reporttime || ''),
    estimated: false,
  }
}

/** 后台拉所在地实况（优先高德；没 key 才退回 open-meteo）；失败就留着季节估
 *  什么时候拉：只在问天气 / 出门 / 到达新地点时；force=true 时忽略 60 秒内的新鲜缓存 */
async function refreshSky(spot, api, { force = false } = {}) {
  const lat = Number(spot?.lat)
  const lon = Number(spot?.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`
  const old = skyCache.get(key)
  if (old && Date.now() - old.at < (force ? 60_000 : SKY_TTL)) return
  try {
    const amapKey = amapKeyOf(api)
    let data
    if (amapKey) {
      data = await amapSky(lat, lon, amapKey)
    } else {
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat}&longitude=${lon}`
        + '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,cloud_cover'
        + '&timezone=Asia%2FShanghai&forecast_days=1'
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`天气接口 ${res.status}`)
      const j = await res.json()
      const c = j?.current || {}
      const temp = Number(c.temperature_2m)
      const windKmh = Number(c.wind_speed_10m)
      data = {
        word: weatherWord(Number(c.weather_code), temp) || '多云',
        temp: Number.isFinite(temp) ? Math.round(temp) : null,
        felt: Number.isFinite(Number(c.apparent_temperature)) ? Math.round(Number(c.apparent_temperature)) : null,
        wind: Number.isFinite(windKmh) && windKmh >= 20 ? '风有点大' : '风不大',
        wet: Number(c.precipitation) > 0.1 || Number(c.weather_code) >= 51,
        estimated: false,
      }
    }
    skyCache.set(key, { at: Date.now(), data })
    api?.log?.debug?.(`天时更新 ${spot?.name || key}：${data.word} ${data.temp}℃`)
  } catch (error) {
    api?.log?.debug?.(`取 ${spot?.name || key} 天气失败：${error?.message}`)
  }
}

/** 一句话天时，给她当台词底子（短，不占 token） */
function skyLine(spot, sky) {
  const est = sky.estimated ? '（按季节估的，没取到实况）' : ''
  const where = spot?.name || '这里'
  return `现在北京时间 ${sky.now}（${where}的${sky.phase}，${sky.season}），`
    + `${where}${sky.word}${typeof sky.temp === 'number' ? ` ${sky.temp}℃` : ''}，`
    + `${sky.wet ? '地面是湿的' : '风' + (sky.wind === '风不大' ? '不大' : '不小')}；`
    + `日出 ${sky.sunrise}、日落 ${sky.sunset}，${sky.dark ? '天已经黑透了' : '离天黑还早，太阳还挂着'}${est}。`
}

// 句子跟时间/自然的绑定：日落、夜里、花开、下海，不合时令整句丢。
const NEED_DARK = /(夜市|路灯|灯箱|串灯|霓虹|天黑|夜里|夜市摊|亮灯)/i
const NEED_SUNSET = /(日落|夕阳|太阳往.*沉|橘色|反着光)/i
const NEED_SPRING = /(花开|开花的树|一朵花|花苞)/i

function sunWindow(sky) {
  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const now = toMin(sky.now)
  const ss = toMin(sky.sunset)
  return now >= ss - 45 && now <= ss + 25
}
function okNow(event, sky) {
  if (!event) return false
  if (NEED_SUNSET.test(event)) return sunWindow(sky)
  if (NEED_DARK.test(event)) return sky.dark
  if (NEED_SPRING.test(event)) return sky.month >= 3 && sky.month <= 5
  return true
}

/** 营业时间（本地点位才有；活动目的地当全天） */
const OPEN = {
  market: [5 * 60, 19 * 60],
  super: [8 * 60, 22 * 60],
  mall: [10 * 60, 22 * 60],
  cafe: [8 * 60, 22 * 60],
  book: [9 * 60, 21.5 * 60],
  store: [0, 24 * 60],
  night: [17 * 60, 23.5 * 60],
}
function openState(spot, ts = Date.now()) {
  const oh = OPEN[spot?.id]
  if (!oh) return { open: true }
  const m = bj(ts).minutes
  const [from, to] = oh
  if (m >= from && m <= to) return { open: true }
  return { open: false, from: hhmm(from), to: hhmm(to) }
}

/** 见闻候选 = 真实地标细节 + 泛写的 */
function eventsOf(spot) {
  return [...(spot?.realDetail || []), ...(spot?.events || [])]
}

function pickEvent(spot, sky, open) {
  if (open && open.open === false) {
    const wet = sky.wet ? '，地上有水' : ''
    const what = spot.id === 'night' ? `${open.from} 才出摊` : `${open.from} 才开门`
    return `现在还没到点，${what}，门关着里面黑着${wet}${sky.dark ? '，只有门口远处的路灯' : ''}`
  }
  const good = eventsOf(spot).filter((e) => okNow(e, sky))
  const base = pickOne(good)
  if (!base) {
    const wet = sky.wet ? '地上有水，走过去得挑干净的地方落脚' : ''
    return `这会儿${sky.phase}，${sky.word}${typeof sky.temp === 'number' ? `，${sky.temp}℃` : ''}${sky.dark ? '，灯都亮着' : ''}${wet ? '，' + wet : ''}`
  }
  return base
}

// ---------- 定位：真实坐标 ----------
/** WGS84 → GCJ02（境内纠偏；境外原样） */
function gcj(lat, lon) {
  const a = 6378245.0
  const ee = 0.00669342162296594323
  const out = (x, y) => y < 72.004 || y > 137.8347 || x < 0.8293 || x > 55.8271
  if (out(lat, lon)) return { lat, lon }
  const tfLat = (x, y) => {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    r += ((20 * Math.sin(6 * x * Math.PI)) + (20 * Math.sin(2 * x * Math.PI))) * 2 / 3
    r += ((20 * Math.sin(y * Math.PI)) + (40 * Math.sin(y / 3 * Math.PI))) * 2 / 3
    r += ((160 * Math.sin(y / 12 * Math.PI)) + (320 * Math.sin(y * Math.PI / 30))) * 2 / 3
    return r
  }
  const tfLon = (x, y) => {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    r += ((20 * Math.sin(6 * x * Math.PI)) + (20 * Math.sin(2 * x * Math.PI))) * 2 / 3
    r += ((20 * Math.sin(x * Math.PI)) + (40 * Math.sin(x / 3 * Math.PI))) * 2 / 3
    r += ((150 * Math.sin(x / 12 * Math.PI)) + (300 * Math.sin(x / 30 * Math.PI))) * 2 / 3
    return r
  }
  let dLat = tfLat(lon - 105, lat - 35)
  let dLon = tfLon(lon - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI)
  dLon = (dLon * 180) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return { lat: lat + dLat, lon: lon + dLon }
}

/** 拼一张 QQ 位置卡片（json 段，字段对着真实卡片描的；网关自带的 location 段在手机上是空气泡） */
function locCard(name, addr, lat, lon, note) {
  const c = gcj(Number(lat), Number(lon))
  const address = String(addr || '')
    .replace(/\s+/g, '')
    .replace(/^四川省成都市(?=四川|广西|重庆|陕西|云南|海南|山东|福建|贵州|湖南)/, '')
  const token = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
  return {
    type: 'json',
    data: {
      data: JSON.stringify({
        app: 'com.tencent.map',
        config: { autosize: false, ctime: Math.floor(Date.now() / 1000), forward: true, token, type: 'normal' },
        desc: String(note || '').trim(),
        from: 1,
        meta: {
          'Location.Search': {
            address,
            enum_relation_type: 0,
            from: 'plusPanel',
            from_account: 0,
            id: '',
            lat: c.lat.toFixed(6),
            lng: c.lon.toFixed(6),
            name,
            uint64_peer_account: 0,
          },
        },
        prompt: `[位置]${name}`,
        ver: '1.1.2.21',
        view: 'LocationShare',
      }),
    },
  }
}

/** 用高德把任意地名/城市解析成真实坐标（key 跟真实定位卡片模块共用） */
async function resolveRemote(api, keywords, city) {
  const key = amapKeyOf(api)
  if (!key) throw new Error('没有高德 key，解析不了这个地名')
  const url = 'https://restapi.amap.com/v3/place/text'
    + `?keywords=${encodeURIComponent(keywords)}&city=${encodeURIComponent(city || '')}`
    + `&citylimit=${city ? 'true' : 'false'}&offset=5&page=1&extensions=base&key=${key}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`高德接口 ${res.status}`)
  const j = await res.json()
  const poi = (j?.pois || [])[0]
  if (!poi || !poi.location) throw new Error('高德没找到这个地名')
  const [lon, lat] = String(poi.location).split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('高德返回的坐标不对')
  const addr = [poi.pname, poi.cityname, poi.adname, poi.address].filter(Boolean).join(' ')
  return { name: poi.name || keywords, lat, lon, addr: addr || `${city || ''}${keywords}` }
}

// ---------- 实景照：当地真照片 ----------
const PHOTO_UA = 'aurabot-outings/1.5 (self-hosted chat bot; +https://commons.wikimedia.org)'
const PHOTO_BAD = /(699pic|veer|gettyimages|alamy|dreamstime|shutterstock|58pic|tukuppt|51miz|lovepik|pngtree|zcool|nipic|sucai|photophoto|tuchong|zhimg|sinaimg)/i
const PHOTO_GOOD = [/(qunarzz|qunar)/i, /(c-ctrip|ctrip)/i, /(mafengwo|mfw)/i, /(dianping|dpfile)/i]

async function commonsScene(spot, api) {
  const term = spot?.wiki
  if (!term) return null
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search'
    + `&gsrsearch=${encodeURIComponent(term)}&gsrnamespace=6&gsrlimit=6`
    + '&prop=imageinfo&iiprop=url|size&iiurlwidth=1600'
  const res = await fetch(url, { headers: { 'User-Agent': PHOTO_UA }, signal: AbortSignal.timeout(9000) })
  if (!res.ok) throw new Error(`commons ${res.status}`)
  const j = await res.json()
  const pages = Object.values(j?.query?.pages || {})
  const cands = pages
    .map((p) => ({ title: p.title, info: p.imageinfo?.[0] }))
    .filter((x) => x.info?.thumburl && /\.(jpe?g|png)$/i.test(x.title))
    .filter((x) => !/map|logo|icon|svg|scan|plan|diagram|chart/i.test(x.title))
    .filter((x) => (x.info.width || 0) >= 1000)
  if (!cands.length) return null
  for (const c of cands.slice(0, 3)) {
    try {
      const r = await fetch(c.info.thumburl, { headers: { 'User-Agent': PHOTO_UA }, signal: AbortSignal.timeout(12000) })
      if (!r.ok) continue
      if (!/image\/(jpeg|jpg|png)/i.test(r.headers.get('content-type') || '')) continue
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 60 * 1024) continue
      return { buf, url: c.info.thumburl, query: term, from: `维基共享·${c.title.replace(/^File:/, '')}` }
    } catch (error) {
      api?.log?.debug?.(`commons 图下载失败：${error?.message}`)
    }
  }
  return null
}

async function bingScene(spot, api) {
  const kw = spot?.kw
  if (!kw) return null
  const q = spot?.photo || `${spot?.name || ''} 实拍`
  const headers = { 'User-Agent': PHOTO_UA, Referer: 'https://cn.bing.com/' }
  const page = `https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&qft=+filterui:photo-photo`
  const res = await fetch(page, { headers, signal: AbortSignal.timeout(9000) })
  if (!res.ok) throw new Error(`搜图失败 ${res.status}`)
  const html = await res.text()
  const items = []
  for (const block of html.split('class="iusc"').slice(1)) {
    const murl = /murl&quot;:&quot;(.*?)&quot;/.exec(block)?.[1] || ''
    const title = /&quot;t&quot;:&quot;(.*?)&quot;/.exec(block)?.[1] || ''
    if (!/^https?:/i.test(murl)) continue
    if (PHOTO_BAD.test(murl) || !PHOTO_GOOD.some((re) => re.test(murl))) continue
    if (!kw.test(title)) continue
    items.push({ murl, title })
  }
  for (const it of items.slice(0, 4)) {
    try {
      const r = await fetch(it.murl, { headers, signal: AbortSignal.timeout(9000) })
      if (!r.ok) continue
      if (!/image\/(jpeg|jpg|png|webp)/i.test(r.headers.get('content-type') || '')) continue
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 60 * 1024 || buf.length > 12 * 1024 * 1024) continue
      return { buf, url: it.murl, query: q, title: it.title, from: `游客实拍·${new URL(it.murl).host}` }
    } catch (error) {
      api?.log?.debug?.(`实景图下载失败 ${it.murl}：${error?.message}`)
    }
  }
  return null
}

async function fetchScene(spot, api) {
  try {
    const b = await bingScene(spot, api)
    if (b) return b
  } catch (error) {
    api?.log?.debug?.(`必应没成：${error?.message}`)
  }
  try { return await commonsScene(spot, api) } catch (error) { api?.log?.debug?.(`commons 没成：${error?.message}`) }
  return null
}

export default {
  id: 'outings',
  name: '出门走走',
  version: '1.6.0',
  api: 1,
  description: '给她屋子外面的世界：本地点位出门、看细节、拍自己的照片、发真实定位卡片、抓当地实景照；另有一整套出门活动（爬山、看海、露营、旅游、古镇、温泉、骑行、钓鱼），天时按她现在所在的那个地方算；定位优先用真实定位卡片模块里主人授权过的位置；她还能自己排今天和往后几天的行程（排安排本身不占出门次数）。',
  tab: 'chat',
  panel: 'panel.js',
  defaults: { enabled: true, farLimitPerDay: 2, tripMaxDays: 3, allowAutoTrip: true, locSource: 'authorized' },
  settings: [
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉以后她不能出门、不看天时、也不发定位' },
    { key: 'farLimitPerDay', label: '每天远门上限', type: 'number', min: 1, max: 6, step: 1, hint: '旅游、看海、爬山这类要折腾半天的，一天跑几趟' },
    { key: 'tripMaxDays', label: '旅游最多住几晚', type: 'number', min: 1, max: 7, step: 1 },
    { key: 'allowAutoTrip', label: '允许她自己决定出远门', type: 'switch', hint: '关掉以后远门只能由主人派遣' },
    {
      key: 'locSource', label: '发定位用哪个位置', type: 'select',
      options: [
        { value: 'authorized', label: '主人授权的真实位置（优先）' },
        { value: 'spot', label: '就用当前点的坐标' },
      ],
      hint: '授权位置来自「真实定位卡片」模块里主人发过的点',
    },
  ],
  setup(api) {
    const s = () => api.settings()
    const { hub } = api.core
    const stateFile = join(api.dataDir(), 'state.json')
    const authFile = join(api.dataDir(), 'auth-loc.json')
    const photoDir = api.dataDir('photos')

    function load() {
      try {
        const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (raw && typeof raw === 'object' && typeof raw.placeId === 'string') return raw
      } catch {}
      return { placeId: HOME, since: Date.now(), trips: {}, trip: null }
    }
    function save(st) {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(stateFile, JSON.stringify(st)) } catch {}
    }
    let state = load()

    /** 把活动目的地还原成「地点」形状（含活动信息、住几天） */
    function tripSpot() {
      const t = state.trip
      if (!t) return null
      if (t.adhoc) return { ...t.adhoc, trip: true, actName: t.actName || '出门', days: t.days || 0, endAt: t.endAt || null }
      const act = ACTS[t.act]
      const dest = act?.dests.find((d) => d.id === t.dest)
      if (!dest) return null
      return { ...dest, kind: act.kind, trip: true, actName: act.name, actId: t.act, destId: dest.id, days: t.days || act.days || 0, endAt: t.endAt || null }
    }

    const here = () => tripSpot() || byId(state.placeId) || HOME_SPOT

    const today = () => bjDay()

    /** 授权位置：① 自己在面板里存过的；② 真实定位卡片模块记下的点位（主人发过定位卡才有） */
    function authLoc() {
      try {
        const own = JSON.parse(readFileSync(authFile, 'utf8'))
        if (Number.isFinite(Number(own?.lat)) && Number.isFinite(Number(own?.lon))) {
          return { lat: Number(own.lat), lon: Number(own.lon), addr: String(own.addr || ''), name: String(own.name || '授权位置'), at: Number(own.at) || null, from: 'manual' }
        }
      } catch {}
      try {
        const rl = join(api.dataDir(), '..', 'real-loc', 'state.json')
        const raw = JSON.parse(readFileSync(rl, 'utf8'))
        const spot = byId(String(raw?.place || ''))
        if (spot && Number.isFinite(Number(spot.lat))) {
          return { lat: spot.lat, lon: spot.lon, addr: spot.addr || '', name: spot.name, at: Number(raw?.since) || null, from: 'real-loc' }
        }
        if (Number.isFinite(Number(raw?.lat)) && Number.isFinite(Number(raw?.lon))) {
          return { lat: Number(raw.lat), lon: Number(raw.lon), addr: String(raw.addr || ''), name: String(raw.name || '授权位置'), at: Number(raw.since) || null, from: 'real-loc' }
        }
      } catch {}
      return null
    }
    function saveAuth(loc) {
      try {
        mkdirSync(api.dataDir(), { recursive: true })
        writeFileSync(authFile, JSON.stringify({ lat: loc.lat, lon: loc.lon, addr: loc.addr || '', name: loc.name || '授权位置', at: Date.now() }))
      } catch (e) { api.log.warn('写授权位置失败：' + e.message) }
    }

    /** 只有提到 / 要回答天气的时候才去拉实况：命中这些词就当场刷一次（60 秒内不重复拉） */
    const WEATHER_RE = /天气|气温|温度|几度|多少度|冷不冷|热不热|降温|升温|下雨|雨|下雪|雪|晴|阴天|多云|雷|冰雹|霜|风大|起风|刮风|湿度|雾|霾|晒|太阳|带伞|伞|穿什么|潮/
    api.on('message', async (msg) => {
      try {
        if (!s().enabled) return false
        const text = String(msg?.text || '')
        if (!text || !WEATHER_RE.test(text)) return false
        const p = here()
        // 让 pipeline 等这次拉取：同一轮里她那句天时就是实况，而不是（估）
        await Promise.race([
          refreshSky(p, api, { force: true }),
          new Promise((resolve) => setTimeout(resolve, 9000)),
        ])
      } catch {}
      return false
    })

    /** 照片别无限涨：只留最近 150 张，老的先删 */
    function prunePhotos(max = 150) {
      try {
        const files = readdirSync(photoDir)
          .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
          .map((f) => { try { return { f, t: statSync(join(photoDir, f)).mtimeMs } } catch { return { f, t: 0 } } })
          .sort((a, b) => b.t - a.t)
        for (const x of files.slice(max)) {
          try { unlinkSync(join(photoDir, x.f)) } catch {}
        }
      } catch {}
    }

    // 不再定时拉天气：只有问天气 / 出门 / 换地方时才拉（见上面 message 钩子与 go / startAct）

    function markTrip(kind) {
      const day = today()
      state.trips = state.trips || {}
      state.trips[day] = state.trips[day] || { far: 0, total: 0 }
      state.trips[day].total = Number(state.trips[day].total || 0) + 1
      if (kind === 'far' || kind === 'trip') state.trips[day].far = Number(state.trips[day].far || 0) + 1
    }

    function remember(text) {
      try {
        const mem = api.use('memory')
        if (mem?.add) mem.add({ text, importance: 0.45, tags: ['outing'], source: 'tool' })
      } catch {}
    }

    function resolveSpot(text) {
      const q = String(text || '').trim().toLowerCase()
      if (!q) return null
      const hit = byId(q) || SPOTS.find((p) => p.name === String(text || '').trim())
        || SPOTS.find((p) => q.includes(p.name))
        || SPOTS.find((p) => p.name.includes(String(text || '').trim()))
      return hit && hit.id !== HOME ? hit : null
    }
    function resolveAct(text) {
      const q = String(text || '').trim()
      if (!q) return null
      const byKey = ACTS[q.toLowerCase()]
      if (byKey) return { id: q.toLowerCase(), ...byKey }
      const hit = Object.entries(ACTS).find(([, a]) => a.name === q || q.includes(a.name) || a.name.includes(q))
      return hit ? { id: hit[0], ...hit[1] } : null
    }
    function resolveDest(act, text) {
      const q = String(text || '').trim()
      if (!q) return null
      const hit = act.dests.find((d) => d.id === q.toLowerCase() || d.name === q || q.includes(d.name) || d.name.includes(q))
      return hit || null
    }

    /** 出门到本地点位（当天回的那种） */
    async function go(spot, reason) {
      const p = spot
      if (p.kind === 'far') {
        const used = Number(state.trips?.[today()]?.far || 0)
        const limit = Math.max(1, Number(s().farLimitPerDay) || 2)
        if (used >= limit) return { ok: false, message: `今天已经跑过 ${used} 趟远门了（${p.name}这种要折腾半天），先歇歇，明天再去也不迟` }
      }
      const now = Date.now()
      const prev = here()
      state.trip = null
      state.placeId = p.id
      state.since = now
      state.lastReason = String(reason || '')
      markTrip(p.kind)
      save(state)
      // 到达新地点：当场拉一次实况，下面那句天时才准
      await refreshSky(p, api).catch(() => {})
      const sky = skyNow(p, now)
      const open = openState(p, now)
      const road = p.travel ? `${p.travel}，路上大概 ${p.mins} 分钟。` : ''
      const where = p.addr && p.addr !== p.name ? `（${p.addr}）` : ''
      const arrive = `到了${p.name}${where}。${pickEvent(p, sky, open)}`
      remember(`出门：${clock(now)} 从${prev.name}去了${p.name}${reason ? '（' + reason + '）' : ''}，${pickEvent(p, sky, open)}`)
      return {
        ok: true,
        message: `${road}${arrive}\n（天时：${skyLine(p, sky)}）\n\n在这儿能做的：${(p.things || []).join('、')}。想看得更细用 out_look，想给他看现在的样子用 out_photo，想让他知道你在哪儿用 out_loc，想给他看这地方真长什么样用 out_scene，回屋里用 out_home。`,
        place: p.id,
        name: p.name,
        at: clock(now),
        sky,
      }
    }

    const clock = (ts) => bjText(ts)

    /** 出发去一个活动（爬山/看海/露营/旅游…）；days>0 表示要在外住几晚；byOwner=主人派遣 */
    async function startAct(act, dest, reason, days, byOwner = false) {
      const kind = act.kind
      const now = Date.now()
      const wantDays = Math.max(0, Math.min(7, Number(days ?? act.days ?? 0)))
      const stay0 = kind === 'trip' ? Math.max(1, Math.min(Math.max(1, Number(s().tripMaxDays) || 3), wantDays || act.days || 1)) : wantDays
      // 住在外面的（露营、温泉也算）都按远门算额度，不然一天能连开好几趟
      const heavy = kind === 'trip' || kind === 'far' || stay0 > 0
      if (heavy) {
        const used = Number(state.trips?.[today()]?.far || 0)
        const limit = Math.max(1, Number(s().farLimitPerDay) || 2)
        if (used >= limit) return { ok: false, message: `今天已经跑过 ${used} 趟远门了，${act.name}这种先留到明天` }
      }
      if (heavy && s().allowAutoTrip === false && !byOwner) return { ok: false, message: '出远门得主人开口（设置里关了自主远门）' }
      const stay = stay0
      const prev = here()
      const endAt = stay > 0 ? now + stay * 86400_000 : null
      state.trip = { act: act.id, actName: act.name, dest: dest.id, days: stay, startAt: now, endAt }
      state.placeId = HOME
      state.since = now
      state.lastReason = String(reason || '')
      markTrip(heavy ? 'far' : kind)
      save(state)
      // 到达新地点：当场拉一次实况
      await refreshSky(dest, api).catch(() => {})
      const sky = skyNow(dest, now)
      const open = openState(dest, now)
      const road = `${act.travel}，路上大概 ${act.mins} 分钟。`
      const tail = stay > 0 ? `这趟要在外面住 ${stay} 晚，到 ${bjDay(endAt)} ${clock(endAt)} 才算回来（期间都算在这儿）。` : '当天回的。'
      const arrive = `到了${dest.name}（${dest.addr}）。${pickEvent(dest, sky, open)}`
      remember(`${act.name}：${clock(now)} 从${prev.name}去了${dest.name}${stay > 0 ? `，住 ${stay} 晚` : ''}${reason ? '（' + reason + '）' : ''}`)
      return {
        ok: true,
        message: `${act.name}。${road}${arrive}\n（天时：${skyLine(dest, sky)}）\n${tail}\n\n在这儿能做的：${(dest.things || []).join('、')}。看细节 out_look，拍自己的照片 out_photo，发定位 out_loc，抓当地实景 out_scene，结束行程 out_home。`,
        place: dest.id,
        name: dest.name,
        act: act.id,
        actName: act.name,
        days: stay,
        at: clock(now),
        sky,
      }
    }

    /** 回家：结束行程 */
    function home() {
      const was = here()
      state.trip = null
      state.placeId = HOME
      state.since = Date.now()
      save(state)
      // 回到家也算换了个地方，拉一次实况
      refreshSky(here(), api).catch(() => {})
      return { ok: true, message: was.id === HOME ? '本来就在屋里。' : `从${was.name}回来了，进门把鞋换了。`, place: HOME }
    }

    async function goByText(text, reason, byOwner = false) {
      const want0 = String(text || '').trim()
      const act = resolveAct(want0)
      if (act) {
        const dest = resolveDest(act, want0) || pickOne(act.dests)
        return await startAct(act, dest, reason, undefined, byOwner)
      }
      const want = want0 ? resolveSpot(want0) : null
      if (want) {
        const r = await go(want, reason)
        if (r.ok) return r
        const near = pickOne(SPOTS.filter((p) => p.kind === 'near' || p.kind === 'mid'))
        const r2 = near && near.id !== state.placeId ? await go(near, `${want.name}今天去不成，就近走走`) : null
        return (r2 && r2.ok) ? r2 : r
      }
      // 没给名字才随机；给了名字却没这个地方，照实回去，别把人悄悄送到别处
      if (want0) return { ok: false, message: `没「${want0}」这个地方。本地能去：${SPOTS.filter((p) => p.id !== HOME).map((p) => p.name).join('、')}；外地或活动用 /出门 爬山 青城山 这种写法` }
      const pool = SPOTS.filter((p) => p.kind !== 'home' && p.id !== state.placeId)
      const pick = pickOne(pool)
      if (!pick) return { ok: false, message: '没地方可去' }
      return await go(pick, reason)
    }

    /** ---------- 计划：她给自己排时间表；只排，不算出门次数 ---------- */
    const PLAN_MAX = 8
    const heavyAct = (id) => {
      const a = ACTS[id]
      return Boolean(a && (a.kind === 'trip' || a.kind === 'far' || Number(a.days) > 0))
    }
    function normDay(text) {
      const t = String(text || '').trim()
      if (!t || t === '今天' || t === 'today') return today()
      if (t === '明天' || t === 'tomorrow') return bjDay(Date.now() + 86400_000)
      if (t === '后天') return bjDay(Date.now() + 2 * 86400_000)
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
      if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
      return today()
    }
    const allPlan = () => (Array.isArray(state.plan) ? state.plan : [])
    function planList(day) {
      const d = normDay(day)
      return allPlan()
        .filter((x) => x.day === d && !x.doneAt)
        .sort((a, b) => String(a.at || '99:99').localeCompare(String(b.at || '99:99')))
    }
    function planAdd({ day, at, place, act, dest, note } = {}) {
      const d = normDay(day)
      const atText = String(at || '').trim()
      if (atText && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(atText)) return { ok: false, message: `「${atText}」不是钟点，写成 09:30 这种（也可以不写时间）` }
      const spot = place ? (resolveSpot(place) || SPOTS.find((p) => p.id === String(place).toLowerCase())) : null
      if (place && !spot) return { ok: false, message: `没「${place}」这个地方。本地能去：${SPOTS.filter((p) => p.id !== HOME).map((p) => p.name).join('、')}` }
      const a = act ? resolveAct(act) : null
      if (act && !a) return { ok: false, message: `没「${act}」这个活动。能做：${Object.values(ACTS).map((x) => x.name).join('、')}` }
      if (!spot && !a) return { ok: false, message: '要给 place（本地哪儿）或者 act（做哪件事）' }
      const dst = a ? (resolveDest(a, dest) || pickOne(a.dests)) : null
      const label = a ? `${a.name}·${dst.name}` : spot.name
      if (allPlan().filter((x) => x.day === d).length >= PLAN_MAX) return { ok: false, message: `${d} 已经排了 ${PLAN_MAX} 件，别再往后堆了` }
      const item = {
        id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        day: d,
        at: atText,
        place: spot ? spot.id : '',
        act: a ? a.id : '',
        dest: dst ? dst.id : '',
        label,
        note: String(note || '').slice(0, 40),
        heavy: a ? heavyAct(a.id) : false,
      }
      state.plan = allPlan().filter((x) => x.day >= today())
      state.plan.push(item)
      save(state)
      const kindText = item.heavy ? '排着不算次数，真去那趟才算远门' : '本地走走、不占远门'
      return { ok: true, message: `记下了：${d === today() ? '今天' : d}${atText ? ' ' + atText : ''} ${label}（${kindText}）。排安排本身不算出门。`, item, plan: planList(d) }
    }
    function planClear(day) {
      const t = String(day || '').trim()
      if (t === '全部' || t === 'all') { state.plan = []; save(state); return { ok: true, message: '安排全清了。' } }
      const d = normDay(day)
      const n = allPlan().filter((x) => x.day === d).length
      state.plan = allPlan().filter((x) => x.day !== d)
      save(state)
      return { ok: true, message: n ? `把${d === today() ? '今天' : d}的 ${n} 件安排清了。` : `${d}本来就没排。` }
    }
    /** 一句「河边」或「爬山 青城山」拆成地方/活动，工具和接口共用 */
    function planWhat({ day, at, what, note } = {}) {
      const w = String(what || '').trim()
      const head = w.split(/\s+/)[0] || ''
      const tail = w.split(/\s+/).slice(1).join(' ')
      if (!head) return planAdd({ day, at, note })
      const hitAct = resolveAct(head)
      const hitSpot = resolveSpot(head) || SPOTS.find((p) => p.id === head.toLowerCase())
      if (!hitAct && !hitSpot) {
        return { ok: false, message: `没「${head}」这个地方，也没这个活动。本地：${SPOTS.filter((p) => p.id !== HOME).map((p) => p.name).join('、')}；活动：${Object.values(ACTS).map((x) => x.name).join('、')}` }
      }
      return hitAct ? planAdd({ day, at, act: hitAct.id, dest: tail, note }) : planAdd({ day, at, place: hitSpot.id, note })
    }
    function planText(day) {      const d = normDay(day)
      const items = planList(d)
      const tag = d === today() ? '今天' : d === bjDay(Date.now() + 86400_000) ? '明天' : d
      if (!items.length) return `${tag}还没排安排。`
      return `${tag}排了 ${items.length} 件（排着不算出门次数）：` + items.map((x) => `${x.at || '时间未定'} ${x.label}${x.note ? '（' + x.note + '）' : ''}`).join('；')
    }
    function planOf(day) {
      return planList(day).map((x) => ({ id: x.id, at: x.at, label: x.label, note: x.note, place: x.place, act: x.act, dest: x.dest }))
    }
    /** 今天到点、还没执行的下一件安排（没写钟点的不自动执行） */
    function planDue(nowHM) {
      const hm = String(nowHM || bjText(Date.now()))
      return planList(today()).find((x) => x.at && x.at <= hm) || null
    }
    /** 执行一条到点安排：本地点位走 out_go，活动走 out_act；成功才标记 doneAt */
    async function runPlan(item) {
      if (!item) return { ok: false, message: '没有到点的安排。' }
      let r = null
      if (item.act) {
        const a = ACTS[item.act]
        if (!a) return { ok: false, message: `安排里的活动「${item.act}」不见了。` }
        const d = resolveDest(a, item.dest) || pickOne(a.dests)
        r = await startAct(a, d, `按今天 ${item.at || ''} 的安排：${item.label}`, item.days, false)
      } else {
        const p = resolveSpot(item.place) || byId(item.place)
        if (!p) return { ok: false, message: `安排里的地点「${item.place}」不见了。` }
        r = await go(p, `按今天 ${item.at || ''} 的安排：${item.label}`)
      }
      if (r && r.ok) {
        const x = allPlan().find((y) => y.id === item.id)
        if (x) { x.doneAt = Date.now(); save(state) }
      }
      return r || { ok: false, message: '安排没执行。' }
    }

    const tools = api.tool(({ chat, sessionId }) => (s().enabled && chat.kind !== 'system' ? [
      api.defineTool({
        name: 'out_go',
        description: '出门去成都本地某个地方（河边、公园、菜市场、商场、山上、都江堰……）。可以自己想去就去；到了看见什么、开不开门都会写在结果里。常用点位：'
          + SPOTS.filter((p) => p.id !== HOME).slice(0, 6).map((p) => `${p.id}=${p.name}`).join('、')
          + '；其余用 out_places 查。外地、爬山、看海、旅游用 out_act。',
        properties: {
          place: { type: 'string', description: '地点 id 或中文名，比如 river / 河边 / 菜市场' },
          reason: { type: 'string', description: '为什么出去（可选）' },
        },
        required: ['place'],
        execute: async ({ place, reason }) => {
          if (chat.kind === 'group' && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '群里不是主人开口，先不动' }
          const hit = resolveSpot(place) || SPOTS.find((p) => p.id === String(place || '').toLowerCase())
          if (!hit) return { ok: false, message: `没这个地方。本地能去：${SPOTS.filter((p) => p.id !== HOME).map((p) => p.name).join('、')}；外地或者活动用 out_act` }
          if (hit.id === HOME) return { ok: true, message: '她本来就在屋里。', place: HOME }
          return await go(hit, reason)
        },
      }),
      api.defineTool({
        name: 'out_act',
        description: '出门去做一件事：爬山、看海、露营、旅游、古镇、温泉、骑行、钓鱼，目的地都是真实地方、有真坐标，可以待几天。她自己决定也行，主人派遣也行。目的地清单用 out_places 查，不写就随机挑一个。',
        properties: {
          act: { type: 'string', description: '活动 id 或中文名，比如 hike / 爬山 / 看海' },
          dest: { type: 'string', description: '目的地 id 或中文名（可选，不写就随机一个）' },
          days: { type: 'number', description: '住几晚（可选；旅游默认按活动设定）' },
          reason: { type: 'string', description: '为什么去（可选）' },
        },
        required: ['act'],
        execute: async ({ act, dest, days, reason }) => {
          if (chat.kind === 'group' && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '群里不是主人开口，先不动' }
          const a = resolveAct(act)
          if (!a) return { ok: false, message: `没这个活动。能做：${Object.values(ACTS).map((x) => x.name).join('、')}` }
          const d = resolveDest(a, dest) || pickOne(a.dests)
          if (!d) return { ok: false, message: `${a.name}没有可去的地方` }
          return await startAct(a, d, reason, days)
        },
      }),
      api.defineTool({
        name: 'out_look',
        description: '在现在这个地方仔细看一看，会看到具体的东西（气味、声音、旁边的人和事）。没出门、在家里时说清楚自己在屋里。',
        properties: { focus: { type: 'string', description: '想看什么（可选）：人、吃的、天气、远处……' } },
        execute: async ({ focus } = {}) => {
          const p = here()
          // 明确要「看天气」时才现场拉一次；其它看细节沿用已有缓存
          if (focus && WEATHER_RE.test(String(focus))) await refreshSky(p, api, { force: true }).catch(() => {})
          const sky = skyNow(p)
          const open = openState(p)
          const line = pickEvent(p, sky, open)
          const others = open.open === false ? [] : eventsOf(p).filter((x) => x !== line && okNow(x, sky))
          const extra = pickOne(others) || ''
          const stay = state.trip?.endAt ? `，这趟还剩 ${Math.max(0, Math.ceil((state.trip.endAt - Date.now()) / 86400_000))} 天` : ''
          return {
            ok: true,
            message: `（在${p.name}，已经待了 ${HOW_LONG(minsSince(state.since))}${stay}；${skyLine(p, sky)}）${focus ? `看着${focus}：` : ''}${line}${extra ? '。旁边' + extra : ''}。`,
            place: p.id,
            sky,
            open,
          }
        },
      }),
      api.defineTool({
        name: 'out_photo',
        description: '就着现在这个地方拍一张照片（真生成一张图，存到本机）。拍完直接给她看或发出去（qq_send_file），不用先 see_image。',
        properties: {
          shot: { type: 'string', description: '这张拍的是什么：她自己在做什么、镜头怎么摆' },
          shape: { type: 'string', description: '构图：portrait 竖（默认）、landscape 横、square 方图' },
        },
        required: ['shot'],
        execute: async ({ shot, shape }) => {
          const gen = api.use('imagegen')
          if (!gen || typeof gen.generate !== 'function') return { ok: false, message: '生图模块没在跑，这会儿拍不了' }
          if (typeof gen.enabled === 'function' && !gen.enabled()) return { ok: false, message: '生图开关关着，拍不了' }
          const p = here()
          const sky = skyNow(p)
          const light = sky.dark
            ? '夜里，只有路灯和店铺灯箱照明，天是黑的，不要白天光、不要日落'
            : `${sky.phase}的${sky.word}天光${typeof sky.temp === 'number' ? `，约 ${sky.temp}℃ 的体感` : ''}，不要日落、不要夜景、不要影棚布光`
          const prompt = `${p.scene}；${String(shot || '').trim()}；${light}；随手拍的真实照片质感`
          const t = Date.now()
          const buf = await gen.generate(prompt, { shape: String(shape || 'portrait') })
          mkdirSync(photoDir, { recursive: true })
          const file = join(photoDir, `out-${t}.jpg`)
          writeFileSync(file, buf)
          prunePhotos()
          remember(`在${p.name}拍了一张：${String(shot || '').slice(0, 40)}（${sky.now}，${sky.word}）`)
          return { ok: true, message: `在${p.name}拍好了（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）。存好了，直接 qq_send_file 发出去就行。`, path: file, place: p.id }
        },
      }),
      api.defineTool({
        name: 'out_places',
        description: '查「能去哪儿」的完整清单：成都本地点位 + 各活动的目的地和住几晚。不确定去哪时先查这个，再用 out_go / out_act。',
        properties: {},
        execute: async () => ({
          ok: true,
          message: `本地：${SPOTS.filter((p) => p.id !== HOME).map((p) => `${p.id}=${p.name}`).join('、')}。\n活动：${Object.entries(ACTS).map(([id, a]) => `${id}=${a.name}（${a.dests.map((d) => d.name).join('/')}，${a.days ? '住' + a.days + '晚' : '当天回'}）`).join('；')}`,
          spots: SPOTS.filter((p) => p.id !== HOME).map((p) => ({ id: p.id, name: p.name })),
          acts: Object.entries(ACTS).map(([id, a]) => ({ id, name: a.name, days: a.days || 0, dests: a.dests.map((d) => ({ id: d.id, name: d.name })) })),
        }),
      }),
      api.defineTool({
        name: 'out_plan',
        description: '给自己排今天或往后几天的安排（只排、不算出门次数；真去还是 out_go/out_act）。',
        properties: {
          action: { type: 'string', description: 'list（默认）/ add / clear' },
          day: { type: 'string', description: '今天、明天、后天或 2026-11-18（默认今天）' },
          at: { type: 'string', description: '几点，09:30 这样（可空）' },
          what: { type: 'string', description: '去哪/做什么：河边、爬山、露营 青城山（add 时填）' },
          note: { type: 'string', description: '备注（可选）' },
        },
        execute: async ({ action, day, at, what, note } = {}) => {
          const a = String(action || 'list').toLowerCase()
          if (a === 'add') return { ...planWhat({ day, at, what, note }), plan: planOf(day) }
          if (a === 'clear') return { ...planClear(day), plan: planOf(day) }
          return { ok: true, message: planText(day), plan: planOf(day), planned: allPlan().length }
        },
      }),
      api.defineTool({
        name: 'out_home',
        description: '回屋里（结束这次出门；外出多日的行程也用它收尾）。',
        properties: {},
        execute: async () => home(),
      }),
      api.defineTool({
        name: 'out_loc',
        description: '把当前定位发到这个聊天（真卡片，点开有地图；默认用主人授权位置）。他问「你在哪」或想让他来找时用。',
        properties: { note: { type: 'string', description: '卡片上附一句话（可选）' } },
        execute: async ({ note } = {}) => {
          if (chat.kind === 'group' && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '群里不是主人开口，不暴露位置' }
          const p = here()
          const auth = authLoc()
          const useAuth = s().locSource !== 'spot' && auth
          const lat = useAuth ? auth.lat : p.lat
          const lon = useAuth ? auth.lon : p.lon
          const addr = useAuth ? (auth.addr || p.addr) : p.addr
          if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return { ok: false, message: '这个地方没有坐标，发不了定位' }
          const seg = locCard(p.name, addr, lat, lon, note)
          try {
            const r = await hub.sendSegments(chat.chatId, [seg], `[定位] ${p.name}`, { throwOnError: true })
            if (!r) return { ok: false, message: '没发出去（总开关关着或试运行）' }
            const c = gcj(Number(lat), Number(lon))
            return {
              ok: true,
              message: `定位发出去了：${p.name}（${useAuth ? '主人授权的位置' : '当前点位的坐标'}，${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}）。他那边能看到地图卡片。`,
              place: p.id,
              lat: c.lat,
              lon: c.lon,
              source: useAuth ? auth.from : 'spot',
            }
          } catch (error) {
            return { ok: false, message: `定位没发出去：${error?.message || '网关不接受'}。照实说没发成，别假装发过了。` }
          }
        },
      }),
      api.defineTool({
        name: 'out_scene',
        description: '从网上抓一张当地实拍照片给他看（不是生成的，画面里没有你）；带 send=true 才直接发。',
        properties: {
          send: { type: 'boolean', description: '默认不填＝只抓下来返回路径；填 true 才直接发到聊天' },
        },
        execute: async ({ send } = {}) => {
          if (chat.kind === 'group' && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '群里不是主人开口，先不发图' }
          const p = here()
          const scene = await fetchScene(p, api)
          if (!scene) return { ok: false, message: '网上没抓到合适的实景图（只收游客实拍、标题里得有这个地名），别拿别的图凑，换个说法或者用 out_photo 拍自己的。' }
          mkdirSync(photoDir, { recursive: true })
          const file = join(photoDir, `scene-${Date.now()}.jpg`)
          writeFileSync(file, scene.buf)
          remember(`在${p.name}翻了当地的实景照片（网上真实照片：${scene.title || scene.from}）`)
          if (send !== true) {
            return {
              ok: true,
              message: `抓到了一张${p.name}的实景照（${Math.round(scene.buf.length / 1024)}KB，网上真实照片：${scene.title || scene.from}）。要给他看就 qq_send_file 发出去，注明是「这地方现在长这样」；不用先 see_image。`,
              path: file,
              place: p.id,
              title: scene.title || '',
              source: scene.url,
            }
          }
          try {
            const r = await hub.sendImage(chat.chatId, file, undefined, undefined, { strict: true })
            if (!r) return { ok: true, path: file, message: '图抓好了但没发出去（总开关或试运行）。别假装发过了。' }
            return { ok: true, message: `实景照发出去了：${p.name}（${Math.round(scene.buf.length / 1024)}KB，网上抓的当地真实照片，画面里没有你）。`, path: file, place: p.id, source: scene.url }
          } catch (error) {
            return { ok: false, message: `图没发出去：${error?.message || '网关拒了'}。别假装发过了。`, path: file }
          }
        },
      }),
    ] : []))

    // 每轮她都知道自己在哪儿、那儿现在几点什么天（压成一行，省上下文）
    api.context(() => {
      if (!s().enabled) return ''
      const p = here()
      const sky = skyNow(p)
      const trip = state.trip?.endAt ? `·${p.actName}剩${Math.max(0, Math.ceil((state.trip.endAt - Date.now()) / 86400_000))}天` : ''
      const where = p.id === HOME ? '屋里' : `${p.name}${trip}`
      const temp = typeof sky.temp === 'number' ? `${Math.round(sky.temp)}℃` : ''
      const planned = planList(today()).length
      return `${sky.now}·${where}·${sky.phase}·${sky.season}·${sky.word}${temp}·日出${sky.sunrise}日落${sky.sunset}${sky.estimated ? '（估）' : ''}${planned ? `·今排${planned}件` : ''}；外面的事按这个说。`
    })

    api.rule((kind) => {
      if (!s().enabled || kind === 'system') return ''
      // 规则文本固定不随设置变（利于缓存）；名单只留常用几个，全量用 out_places 查
      return [
        `你可以自己出门，不用征求他同意：本地用 out_go（${SPOTS.filter((p) => p.id !== HOME).map((p) => p.name).slice(0, 5).join('、')}等，全量清单用 out_places）；爬山、看海、露营、旅游、古镇、温泉、骑行、钓鱼用 out_act（目的地用 out_places 查或随机）。这些地方都是真的、有真坐标，工具会告诉你路上多久、到了看见什么。想给自己排今天或往后几天的安排用 out_plan（只排、不算出门次数，真去还是 out_go/out_act）。`,
        '天时按你现在所在的那个地方算（北京时间、那里的日出日落、季节、天气）；换了城市日落也跟着变，别拿成都的日落说三亚的傍晚。',
        '出门那趟的见闻结果里已经带了，别再调 out_look 重复看一遍；想看更细再看。out_photo 拍完就直接发（qq_send_file 或发图），不用先 see_image。out_scene 是别人在当地拍的实景、画面里没有你——别当自己的自拍，说「这地方现在长这样」。',
        '想让他知道你在哪儿用 out_loc（真卡片、点开有地图，默认用主人授权的位置）；群里不是主人开口别发定位。人不在屋里别说「我去看看窗外」「我在房间」；回家和多日行程收尾都用 out_home。',
        '外面的事只说工具给到的和合理推得出来的：别编景点、别编晴雨温度；日落只在日落前后那一小会说，白天太阳还挂着时别说天要黑、别说路灯亮、别说夜市出摊。出门那趟结果里会写这个地方开不开门，关着就写门口的样子。',
      ].join('\n')
    })

    api.command({ name: '在哪', desc: '看她现在在哪儿', run: () => { const p = here(); const st = state.trips?.[today()] || {}; return p.id === HOME ? `她在屋里（${clock(state.since)} 回到家的）。今天出门 ${st.total || 0} 次，其中远门 ${st.far || 0} 次。` : `她在${p.name}（${clock(state.since)} 出来的，待了 ${HOW_LONG(minsSince(state.since))}）${st.far ? `；今天远门 ${st.far} 次` : ''}。` } })

    api.command({
      name: '出门', desc: '让她出门：/出门 河边 ；/出门 爬山 青城山 ；/出门 看海',
      run: async (arg) => {
        const q = String(arg || '').trim()
        if (!q) return `用法：/出门 河边、/出门 爬山、/出门 看海、/出门 旅游 大理。本地：${SPOTS.filter((p) => p.id !== HOME).slice(0, 8).map((p) => p.name).join('|')}`
        const r = await goByText(q, '主人让她去', true)
        return r.message
      },
    })

    api.command({
      name: '活动', desc: '看能做什么活动、去哪', run: () => Object.values(ACTS).map((a) => `${a.name}：${a.dests.map((d) => d.name).join('、')}${a.days ? `（${a.days} 晚）` : '（当天回）'}`).join('\n') || '没有活动',
    })

    api.command({ name: '回家', desc: '让她回屋里', run: () => home().message })

    api.command({
      name: '计划', desc: '看她今天/明天的安排：/计划 ；/计划 明天 ；/计划清 ；/计划加 09:30 河边',
      run: (arg) => {
        const t = String(arg || '').trim()
        if (!t) return planText() + '\n' + planText(bjDay(Date.now() + 86400_000))
        if (t === '清' || t === '清空') return planClear().message
        const m = /^加\s*(?:(\d{1,2}:\d{2})\s*)?(.+)$/.exec(t)
        if (m) return planWhat({ at: m[1] || '', what: m[2] }).message
        return planText(t)
      },
    })

    // ---------- 面板接口 ----------
    const q = (req) => { try { return api.core.http.query(req) || {} } catch (e) { return {} } }

    api.route('/status', () => {
      const p = here()
      const gen = api.use('imagegen')
      const sky = skyNow(p)
      const auth = authLoc()
      const trip = state.trip
      return {
        ok: true,
        place: p.id,
        name: p.name,
        addr: p.addr || '',
        lat: p.lat ?? null,
        lon: p.lon ?? null,
        trip: trip ? { act: trip.act, actName: trip.actName, dest: trip.dest, days: trip.days, endAt: trip.endAt, left: trip.endAt ? Math.max(0, Math.ceil((trip.endAt - Date.now()) / 86400_000)) : 0 } : null,
        since: clock(state.since),
        minutes: minsSince(state.since),
        sky,
        skyLine: skyLine(p, sky),
        auth: auth ? { from: auth.from, name: auth.name, lat: auth.lat, lon: auth.lon, addr: auth.addr } : null,
        imagegen: { has: Boolean(gen), canGenerate: typeof gen?.generate === 'function', enabled: typeof gen?.enabled === 'function' ? gen.enabled() : null },
        today: state.trips?.[today()] || {},
        plan: { day: today(), items: planOf(), tomorrow: planOf(bjDay(Date.now() + 86400_000)) },
        spots: SPOTS.filter((x) => x.id !== HOME).map((x) => ({ id: x.id, name: x.name, mins: x.mins, open: OPEN[x.id] ? `${hhmm(OPEN[x.id][0])}-${hhmm(OPEN[x.id][1])}` : '全天' })),
        acts: Object.entries(ACTS).map(([id, a]) => ({ id, name: a.name, days: a.days || 0, dests: a.dests.map((d) => ({ id: d.id, name: d.name, lat: d.lat, lon: d.lon })) })),
        settings: s(),
      }
    })

    api.route('/go', async (req) => {
      const to = String(q(req).place || '').trim()
      const r = await goByText(to, '手动让她出门', true)
      return { ...r, current: here().name }
    })

    api.route('/act', async (req) => {
      const aq = q(req)
      const rawAct = String(aq.act || '').trim()
      const act = rawAct ? resolveAct(rawAct) : pickOne(Object.entries(ACTS).map(([id, a]) => ({ id, ...a })))
      if (!act) return { ok: false, message: `没「${rawAct}」这个活动。能做：${Object.values(ACTS).map((a) => a.name).join('、')}` }
      const dest = resolveDest(act, aq.dest) || pickOne(act.dests)
      const days = aq.days === undefined || aq.days === '' ? undefined : Number(aq.days)
      const r = await startAct(act, dest, String(aq.reason || '面板派遣'), days, true)
      return { ...r, current: here().name }
    })

    api.route('/home', () => ({ ...home(), current: '家' }))

    api.route('/plan', (req) => {
      const pq = q(req)
      const action = String(pq.action || 'list').toLowerCase()
      if (action === 'add') {
        const r = pq.what ? planWhat({ day: pq.day, at: pq.at, what: pq.what, note: pq.note }) : planAdd({ day: pq.day, at: pq.at, place: pq.place, act: pq.act, dest: pq.dest, note: pq.note })
        return { ...r, plan: planOf(pq.day || r.item?.day) }
      }
      if (action === 'clear') {
        const r = planClear(pq.day)
        return { ...r, plan: planOf(pq.day) }
      }
      return { ok: true, message: planText(pq.day), day: normDay(pq.day), plan: planOf(pq.day), tomorrow: planOf(bjDay(Date.now() + 86400_000)) }
    })

    api.route('/look', () => {
      const p = here()
      const sky = skyNow(p)
      return { ok: true, place: p.id, name: p.name, line: pickEvent(p, sky, openState(p)), sky, skyLine: skyLine(p, sky) }
    })

    api.route('/places', () => ({
      ok: true,
      current: here().name,
      list: SPOTS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, mins: p.mins, lat: p.lat, lon: p.lon, addr: p.addr, open: OPEN[p.id] ? `${hhmm(OPEN[p.id][0])}-${hhmm(OPEN[p.id][1])}` : '全天' })),
    }))

    api.route('/acts', () => ({
      ok: true,
      list: Object.entries(ACTS).map(([id, a]) => ({ id, name: a.name, kind: a.kind, days: a.days || 0, intro: a.intro, dests: a.dests.map((d) => ({ id: d.id, name: d.name, lat: d.lat, lon: d.lon, addr: d.addr })) })),
    }))

    api.route('/sky', () => { const p = here(); const sky = skyNow(p); return { ok: true, place: p.name, sky, line: skyLine(p, sky) } })

    api.route('/auth', (req) => {
      const aq = q(req)
      const lat = Number(aq.lat)
      const lon = Number(aq.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, message: '要给 lat / lon' }
      saveAuth({ lat, lon, addr: String(aq.addr || ''), name: String(aq.name || '授权位置') })
      return { ok: true, message: '授权位置已记下', auth: authLoc() }
    })

    api.route('/loc', async (req) => {
      const aq = q(req)
      const p = here()
      const auth = authLoc()
      const useAuth = s().locSource !== 'spot' && auth
      const lat = useAuth ? auth.lat : p.lat
      const lon = useAuth ? auth.lon : p.lon
      const addr = useAuth ? (auth.addr || p.addr) : p.addr
      if (!Number.isFinite(Number(lat))) return { ok: false, message: '当前地点没有坐标' }
      const seg = locCard(p.name, addr, lat, lon, String(aq.note || ''))
      try {
        const chats = Object.keys(hub.sessions?.() || {})
        const target = chats.find((id) => id.startsWith('private:')) || chats[0]
        if (!target) return { ok: false, message: '没有活跃会话能发' }
        await hub.sendSegments(target, [seg], `[定位] ${p.name}`, { throwOnError: true })
        const card = JSON.parse(seg.data.data)
        return { ok: true, target, place: p.name, lat: card.meta['Location.Search'].lat, lon: card.meta['Location.Search'].lng, address: card.meta['Location.Search'].address, source: useAuth ? auth.from : 'spot' }
      } catch (error) {
        return { ok: false, message: `没发出去：${error?.message || '网关拒绝'}` }
      }
    })

    api.route('/scene', async (req) => {
      const aq = q(req)
      const p = resolveSpot(aq.place) || byId(aq.place) || here()
      try {
        const scene = await fetchScene(p, api)
        if (!scene) return { ok: false, message: `没抓到 ${p.name} 的实景图` }
        mkdirSync(photoDir, { recursive: true })
        const file = join(photoDir, `scene-${Date.now()}.jpg`)
        writeFileSync(file, scene.buf)
        let sent = false
        if (String(aq.send || '0') === '1') {
          const chats = Object.keys(hub.sessions?.() || {})
          const target = chats.find((id) => id.startsWith('private:')) || chats[0]
          if (target) { await hub.sendImage(target, file, undefined, undefined, { strict: true }); sent = true }
        }
        return { ok: true, message: `抓到了${p.name}的实景（${Math.round(scene.buf.length / 1024)}KB，${scene.from || '网上实拍'}）${sent ? '，已经发到她聊天' : '（没发出去，只存在本机）'}`, place: p.name, file, kb: Math.round(scene.buf.length / 1024), query: scene.query, source: scene.url, from: scene.from, sent }
      } catch (error) {
        return { ok: false, message: error?.message || '抓图失败' }
      }
    })

    // 指定时间预览（排查天时用）：/preview?place=river&at=13:57
    api.route('/preview', (req) => {
      const aq = q(req)
      const p = resolveSpot(aq.place) || byId(aq.place) || here()
      let ts = Date.now()
      const rawAt = String(aq.at || '').trim()
      if (rawAt) {
        const mt = /^(\d{1,2}):(\d{2})$/.exec(rawAt)
        if (!mt || Number(mt[1]) > 23 || Number(mt[2]) > 59) return { ok: false, message: `时间要写成 HH:MM（0-23:00-59），收到的是「${rawAt}」` }
        const t = bj(); ts = Date.UTC(t.y, t.m - 1, t.d, Number(mt[1]) - TZ, Number(mt[2]))
      }
      const sky = skyNow(p, ts)
      const open = openState(p, ts)
      const line = pickEvent(p, sky, open)
      return { ok: true, place: p.id, name: p.name, at: sky.now, phase: sky.phase, dark: sky.dark, sunset: sky.sunset, season: sky.season, open, line, sunsetInLine: NEED_SUNSET.test(line), skyLine: skyLine(p, sky) }
    })

    // 主人派遣去任意地名（不在预设里也能去，用高德解析真坐标）
    api.route('/remote', async (req) => {
      const aq = q(req)
      const name = String(aq.name || '').trim()
      const city = String(aq.city || '').trim()
      if (!name) return { ok: false, message: '要给 name（地名）' }
      try {
        const r = await resolveRemote(api, name, city)
        const spot = {
          id: 'remote-' + Date.now().toString(36), name: r.name, kind: 'trip', mins: 120, travel: '坐车/高铁过去',
          lat: r.lat, lon: r.lon, addr: r.addr, scene: `${r.name}的街上，当地的房子和来往的人`,
          things: ['沿街走一段', '找个店吃口热的', '看看当地人在做什么'],
          events: ['街上的招牌大半是当地的字', '有人推着小车从身边过去，轮子很响', '巷子口有人在聊天，语速很快'],
        }
        if (String(aq.go || '0') === '1') {
          const act = { id: 'remote', name: '出门', kind: 'trip', travel: spot.travel, mins: spot.mins, days: Number(aq.days || 0) }
          state.trip = { act: 'remote', actName: '出门', dest: spot.id, days: Math.max(0, Number(aq.days || 0)), startAt: Date.now(), endAt: Number(aq.days || 0) > 0 ? Date.now() + Number(aq.days) * 86400_000 : null, adhoc: spot }
          state.placeId = HOME
          state.since = Date.now()
          markTrip('trip')
          save(state)
          refreshSky(spot, api).catch(() => {})
          return { ok: true, ...spot, current: spot.name }
        }
        return { ok: true, ...spot }
      } catch (error) {
        return { ok: false, message: error?.message || '解析失败' }
      }
    })

    // 给别的模块用：她现在在哪儿（room3d / 自主生活靠这个判断「人不在屋里」）
    return {
      isHome: () => here().id === HOME,
      where: () => {
        const p = here()
        return { id: p.id, name: p.name, home: p.id === HOME, minutes: minsSince(state.since), since: clock(state.since), act: state.trip?.actName || '', days: state.trip?.days || 0 }
      },
      go: (text, reason) => goByText(text, reason),
      planDue: (nowHM) => planDue(nowHM),
      runPlan: (item) => runPlan(item),
      act: (actId, destId, reason, days) => {
        const a = resolveAct(actId)
        if (!a) return { ok: false, message: '没有这个活动' }
        const d = resolveDest(a, destId) || pickOne(a.dests)
        return startAct(a, d, reason, days)
      },
      home: () => home(),
      places: () => SPOTS.filter((p) => p.id !== HOME).map((p) => ({ id: p.id, name: p.name, kind: p.kind, mins: p.mins, lat: p.lat, lon: p.lon })),
      acts: () => Object.entries(ACTS).map(([id, a]) => ({ id, name: a.name, days: a.days || 0, dests: a.dests.map((d) => ({ id: d.id, name: d.name, lat: d.lat, lon: d.lon })) })),
    }
  },
}
