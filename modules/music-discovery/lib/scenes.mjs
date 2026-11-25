// 场景 → 网易云歌单分类 / 榜单的映射。
// 分类名取自公开协议资料里的平台分类（materials/netease-top-playlist.js 的 cat 注释），
// 不是我们自己编的歌单；命中后由 provider 去平台查真实歌单。

export const CHARTS = Object.freeze([
  { id: '3778678', name: '热歌榜', keys: ['热歌', '热门', '最火', '火的歌', '热榜'] },
  { id: '3779629', name: '新歌榜', keys: ['新歌', '最新', '新发行', '刚出'] },
  { id: '19723756', name: '飙升榜', keys: ['飙升', '上升', '黑马', '突然火'] },
  { id: '2884035', name: '原创榜', keys: ['原创'] },
])

export const SCENE_EXAMPLES = '学习、工作、运动、通勤、夜晚、治愈、伤感、放松、古风、说唱、粤语、ACG'

export const SCENES = Object.freeze([
  { cat: '学习', label: '学习/专注', keys: ['学习', '自习', '专注', '写作业', '看书', '刷题', 'study', 'focus'] },
  { cat: '工作', label: '工作/办公', keys: ['工作', '办公', '上班', '写代码', '代码', 'coding', 'work'] },
  { cat: '运动', label: '运动/健身', keys: ['运动', '健身', '跑步', '撸铁', '锻炼', 'workout', 'run'] },
  { cat: '夜晚', label: '夜晚/睡前', keys: ['深夜', '夜晚', '晚上', '睡前', '助眠', '失眠', 'night'] },
  { cat: '清晨', label: '清晨/起床', keys: ['清晨', '早上', '起床', '晨跑', 'morning'] },
  { cat: '驾车', label: '开车/通勤', keys: ['开车', '驾车', '通勤', '堵车', '路上', 'drive'] },
  { cat: '地铁', label: '地铁/公交', keys: ['地铁', '公交', '挤车'] },
  { cat: '旅行', label: '旅行/出游', keys: ['旅行', '出游', '旅游', '自驾', 'travel'] },
  { cat: '散步', label: '散步/闲逛', keys: ['散步', '闲逛', '遛弯', 'walk'] },
  { cat: '下午茶', label: '下午茶/咖啡', keys: ['下午茶', '咖啡', '午后', '下午'] },
  { cat: '午休', label: '午休/小憩', keys: ['午休', '小憩', '打盹'] },
  { cat: '酒吧', label: '酒吧/夜店', keys: ['酒吧', '夜店', '蹦迪', 'clubbing'] },
  { cat: '治愈', label: '治愈/安慰', keys: ['治愈', '安慰', '温柔', '被治愈', 'healing'] },
  { cat: '伤感', label: '伤感/失恋', keys: ['伤感', '失恋', '难过', '伤心', 'emo', '心碎'] },
  { cat: '放松', label: '放松/慵懒', keys: ['放松', '慵懒', '松弛', 'chill', 'relax'] },
  { cat: '安静', label: '安静/独处', keys: ['安静', '独处', '一个人'] },
  { cat: '快乐', label: '快乐/兴奋', keys: ['快乐', '开心', '兴奋', '嗨', '高兴'] },
  { cat: '怀旧', label: '怀旧/老歌', keys: ['怀旧', '老歌', '回忆', '童年', 'nostalgia'] },
  { cat: '浪漫', label: '浪漫/恋爱', keys: ['浪漫', '恋爱', '约会', '表白', '甜'] },
  { cat: '清新', label: '清新', keys: ['清新', '小清新'] },
  { cat: '孤独', label: '孤独', keys: ['孤独', '寂寞'] },
  { cat: '思念', label: '思念', keys: ['思念', '想家', '想念'] },
  { cat: '感动', label: '感动', keys: ['感动', '催泪'] },
  { cat: '游戏', label: '游戏', keys: ['游戏', '打游戏', '开黑', 'gaming'] },
  { cat: '古风', label: '古风/国风', keys: ['古风', '国风', '戏腔'] },
  { cat: 'ACG', label: 'ACG/二次元', keys: ['二次元', '动漫', 'acg', '番剧'] },
  { cat: '影视原声', label: '影视原声', keys: ['影视', '原声', 'ost', '电影', '电视剧'] },
  { cat: '校园', label: '校园/青春', keys: ['校园', '青春', '毕业', '学生'] },
  { cat: '摇滚', label: '摇滚', keys: ['摇滚', 'rock', '乐队'] },
  { cat: '说唱', label: '说唱', keys: ['说唱', 'rap', 'hiphop', '嘻哈'] },
  { cat: '电子', label: '电子', keys: ['电子', 'edm', '电音', 'house'] },
  { cat: '民谣', label: '民谣', keys: ['民谣', 'folk', '吉他弹唱'] },
  { cat: '爵士', label: '爵士', keys: ['爵士', 'jazz'] },
  { cat: '轻音乐', label: '轻音乐/纯音乐', keys: ['轻音乐', '纯音乐', '钢琴', '器乐', 'piano'] },
  { cat: '古典', label: '古典', keys: ['古典', 'classical', '交响'] },
  { cat: '后摇', label: '后摇', keys: ['后摇', 'post rock', 'postrock'] },
  { cat: 'Bossa Nova', label: 'Bossa Nova', keys: ['bossa'] },
  { cat: '粤语', label: '粤语/港乐', keys: ['粤语', '港乐', '广东歌'] },
  { cat: '日语', label: '日语', keys: ['日语', '日系', 'jpop'] },
  { cat: '韩语', label: '韩语', keys: ['韩语', 'kpop', '韩国'] },
  { cat: '欧美', label: '欧美', keys: ['欧美', '英文歌', 'western', '英文'] },
  { cat: '华语', label: '华语', keys: ['华语', '中文歌', '国语'] },
  { cat: 'KTV', label: 'KTV/嗨歌', keys: ['ktv', '嗨歌', '麦霸'] },
  { cat: '经典', label: '经典', keys: ['经典', '老经典'] },
  { cat: '儿童', label: '儿童', keys: ['儿童', '儿歌', '宝宝'] },
])

const CHART_KEYS = CHARTS.flatMap((chart) => chart.keys.map((key) => ({ key, chart })))
const SCENE_KEYS = SCENES.flatMap((scene) => scene.keys.map((key) => ({ key, scene })))

function normalizeInput(input) {
  return String(input || '').trim().toLowerCase().replace(/\s+/g, '')
}

/** 按输入里是否出现关键词匹配；长关键词优先，避免「热歌」吃掉「热歌榜单」之类。 */
function longestHit(text, rows, pick) {
  let best = null
  for (const row of rows) {
    if (!text.includes(row.key)) continue
    if (!best || row.key.length > best.key.length) best = row
  }
  return best ? pick(best) : null
}

/**
 * @returns {{ok:true,kind:'chart'|'playlist',cat?:string,chartId?:string,chartName?:string,label:string,matched:string}
 *   | {ok:false,reason:'empty'|'unknown',message:string}}
 */
export function resolveScene(input) {
  const text = normalizeInput(input)
  if (!text) {
    const chart = CHARTS[0]
    return { ok: true, kind: 'chart', chartId: chart.id, chartName: chart.name, label: chart.name, matched: '默认' }
  }

  const chart = longestHit(text, CHART_KEYS, (row) => row.chart)
  if (chart) {
    return { ok: true, kind: 'chart', chartId: chart.id, chartName: chart.name, label: chart.name, matched: chart.name }
  }

  // 只说「榜单 / 排行榜」时按热歌榜算
  if (/榜单|排行榜/.test(text)) {
    const top = CHARTS[0]
    return { ok: true, kind: 'chart', chartId: top.id, chartName: top.name, label: top.name, matched: '榜单' }
  }

  const scene = longestHit(text, SCENE_KEYS, (row) => row.scene)
  if (scene) {
    return { ok: true, kind: 'playlist', cat: scene.cat, label: scene.label, matched: scene.cat }
  }

  // 允许直接写平台分类名
  const direct = SCENES.find((item) => normalizeInput(item.cat) === text)
  if (direct) return { ok: true, kind: 'playlist', cat: direct.cat, label: direct.label, matched: direct.cat }

  return {
    ok: false,
    reason: 'unknown',
    message: `没有「${String(input).slice(0, 20)}」对应的歌单分类。可以换成场景或曲风，比如：${SCENE_EXAMPLES}`,
  }
}
