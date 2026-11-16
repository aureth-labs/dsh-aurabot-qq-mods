// ==========================================================================
//  real-loc · 真实定位卡片模块（著作权保护版）
//
//  著作权人：默默相伴澜
//  作品名称：澜 · 真实定位卡片模块（real-loc）
//  版本：1.7.0
//
//  版权所有，著作权归「默默相伴澜」唯一专有。
//  未经著作权人书面授权，不得复制、转载、改写、二次发行、嵌入他人产品，
//  尤其不得用于任何商业用途（售卖、付费服务、随货附赠、商业定制、平台抽成等）。
//  本文件与同目录 license.qfl 构成完整的加密署名，二者不可分离。
//  授权核验：verify/verify.mjs（需著作权人持有的专属解密代码）。
//
//  说明：本模块只做一件事——把「人在哪儿」用一条能点开地图的真实位置卡片发出去。
//  坐标纠偏、卡片结构、字段规范是这件事的全部难点，代码按可验证的形式保留。
// ==========================================================================

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const LICENSE_FILE = join(HERE_DIR, 'license.qfl')
const HOME = 'home'

// ---------- 授权校验（配套专属验证特性） ----------
//
// 载入即校验，不通过就不注册任何工具：宁可不说话，也不让盗版顶着这个名字发定位。
// 校验三层：
//   1) license.qfl 存在且结构完整（sig 标记 + 著作权人 + 作品名）
//   2) 清封存值 seal 与「本文件 + module.json + panel.js」的实际摘要一致（检出被改动）
//   3) 加密正文由著作权人的专属解密代码才能解开（verify/verify.mjs，版权归属的最终凭据）

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function selfSeal() {
  try {
    return sha256(Buffer.concat([
      readFileSync(join(HERE_DIR, 'index.mjs')),
      readFileSync(join(HERE_DIR, 'module.json')),
      readFileSync(join(HERE_DIR, 'panel.js')),
    ]))
  } catch {
    return ''
  }
}

function readLicense() {
  try {
    return JSON.parse(readFileSync(LICENSE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function assertLicensed() {
  const lic = readLicense()
  if (!lic || lic.sig !== 'QFL-2026' || !lic.holder || !lic.work) {
    throw new Error(
      '【著作权校验失败】未找到有效的加密署名（license.qfl）。本模块著作权归「默默相伴澜」专有，'
      + '未经授权不得盗用、改写、转载或用于商业用途。请向著作权人取得授权与完整文件后重试。',
    )
  }
  const seal = selfSeal()
  if (!seal || lic.seal !== seal) {
    throw new Error(
      '【著作权校验失败】文件与加密署名不一致：本模块被改动过，授权作废。'
      + '著作权归「默默相伴澜」专有，改动后的版本不得继续使用或分发。'
    )
  }
  return { ...lic, sealOk: true }
}

const LICENSE = assertLicensed()

// ---------- 地点表（WGS84 原始坐标） ----------
// 只留定位需要的字段：名字、坐标、门牌、检索词。坐标误差几十到两百米，按地名估的。

const PLACES = {
  home: { name: '家', lat: 30.6640, lon: 104.0280, addr: '成都 青羊区 双清南路一带' },
  lane: { name: '楼下', lat: 30.6638, lon: 104.0282, addr: '小区门口' },
  garden: { name: '小区花园', lat: 30.6636, lon: 104.0276, addr: '小区中庭' },
  store: { name: '楼下便利店', lat: 30.6632, lon: 104.0290, addr: '红旗连锁' },
  market: { name: '玉林菜市场', lat: 30.6300, lon: 104.0620, addr: '成都 武侯区 玉林' },
  super: { name: '超市', lat: 30.6320, lon: 104.0600, addr: '成都 武侯区 玉林 永辉' },
  cafe: { name: '玉林的咖啡馆', lat: 30.6290, lon: 104.0605, addr: '成都 武侯区 玉林' },
  book: { name: '方所书店', lat: 30.6516, lon: 104.0806, addr: '成都 锦江区 太古里 方所' },
  mall: { name: '太古里', lat: 30.6519, lon: 104.0810, addr: '成都 锦江区 中纱帽街' },
  river: { name: '合江亭河边', lat: 30.6487, lon: 104.0866, addr: '成都 锦江区 合江亭' },
  park: { name: '人民公园', lat: 30.6605, lon: 104.0620, addr: '成都 青羊区 少城路' },
  cinema: { name: '电影院', lat: 30.6580, lon: 104.0700, addr: '成都 青羊区 影院' },
  night: { name: '建设巷夜市', lat: 30.6788, lon: 104.0996, addr: '成都 成华区 建设巷' },
  lake: { name: '青龙湖', lat: 30.6090, lon: 104.2100, addr: '成都 成华区 青龙湖湿地' },
  mountain: { name: '龙泉山', lat: 30.5420, lon: 104.2900, addr: '成都 龙泉驿区 龙泉山观景台' },
  sea: { name: '都江堰', lat: 31.0020, lon: 103.5770, addr: '成都 都江堰 南桥' },
}

// ---------- 本地坐标覆盖（不改代码就能换城市） ----------
//
// 同目录放 places.local.json，按 id 覆盖名字 / 坐标 / 门牌即可，例如：
//   { "home": { "name": "家", "lat": 39.9042, "lon": 116.4074, "addr": "北京 东城区" } }
// 这份文件不在加密署名的摘要范围内 —— 所以别人适配自己的城市，不用改 index.mjs，
// 也不会把授权校验弄失效。改代码才会失效，这是故意的。

try {
  const raw = JSON.parse(readFileSync(join(HERE_DIR, 'places.local.json'), 'utf8'))
  for (const [id, p] of Object.entries(raw || {})) {
    if (!p || typeof p !== 'object') continue
    const lat = Number(p.lat)
    const lon = Number(p.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    PLACES[id] = {
      name: String(p.name || PLACES[id]?.name || id),
      lat, lon,
      addr: String(p.addr || PLACES[id]?.addr || ''),
    }
  }
} catch {}

/** 按 id / 全名 / 名字片段挑一个地点 */function resolvePlace(text) {
  const q = String(text || '').trim()
  if (!q) return null
  const key = Object.keys(PLACES).find((id) => id === q.toLowerCase())
  if (key) return { id: key, ...PLACES[key] }
  const byName = Object.entries(PLACES).find(([, p]) => p.name === q)
    || Object.entries(PLACES).find(([, p]) => p.name.includes(q) || q.includes(p.name))
  return byName ? { id: byName[0], ...byName[1] } : null
}

// ---------- 坐标纠偏 ----------
//
// 存的是 WGS84，QQ 地图用的是火星坐标 GCJ02。不纠偏，卡片落点会偏几百米，
// 点开地图一看就不在河边上，整张卡片的可信度就没了。

/** WGS84 → GCJ02（中国大陆境内偏移修正；境外原样返回） */
function gcj(lat, lon) {
  const a = 6378245.0
  const ee = 0.00669342162296594323
  const out = (lat, lon) => lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
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

// ---------- 全国点位检索（高德 Web 服务，可选） ----------
//
// 本地表只有成都 16 个点，出了成都就不够用。配一把高德 Web 服务 key 之后：
//   地名 → POI 搜索 → 拿真实坐标与真实地址（高德返回的是 GCJ02，不再二次纠偏）
//   坐标 → 逆地理编码 → 反查这到底是哪儿（查不实就拒绝发卡，不许瞎标）
// 没配 key 时自动退化为「只用本地表」，不会报错也不会伪造。

const AMAP = 'https://restapi.amap.com/v3'

// 这些 infocode 说明「这把 key 用不了」，不是这一问本身有问题：换下一把再试。
//   10001 INVALID_USER_KEY   10002 SERVICE_NOT_AVAILABLE   10003 DAILY_QUERY_OVER_LIMIT
//   10005 ACCESS_TOO_FREQUENT 10007 INSUFFICIENT_PRIVILEGES 10009 USERKEY_PLAT_NOMATCH
//   10044 USER_DAILY_QUERY_OVER_LIMIT  10045 USER_KEY_RATE_LIMITED
const KEY_ERROR_CODES = new Set(['10001', '10002', '10003', '10005', '10007', '10009', '10044', '10045'])

/**
 * 打高德接口，支持多把 key：按顺序试，遇到 key 类错误就自动换下一把。
 * 返回 { json, keyIndex }——keyIndex 只用于回报「这次用的是第几把」，不外泄 key 本身。
 */
async function amapCall(path, params, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean)
  if (!list.length) throw new Error('没有可用的高德 key')
  let lastError = '高德接口返回失败'
  for (let i = 0; i < list.length; i += 1) {
    const q = new URLSearchParams({ ...params, key: list[i] })
    let json
    try {
      const res = await fetch(`${AMAP}/${path}?${q}`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`高德接口 HTTP ${res.status}`)
      json = await res.json()
    } catch (error) {
      lastError = error?.message || '请求失败'
      continue
    }
    if (String(json.status) === '1') return { json, keyIndex: i }
    lastError = String(json.info || `高德返回 ${json.infocode || '失败'}`)
    if (!KEY_ERROR_CODES.has(String(json.infocode || ''))) throw new Error(lastError)
  }
  throw new Error(lastError)
}

/** 按地名查 POI，返回候选（坐标已是 GCJ02） */
async function poiFind(keys, keywords, city) {
  const params = { keywords, offset: '6', page: '1', extensions: 'base' }
  if (city) params.city = city
  const { json } = await amapCall('place/text', params, keys)
  const pois = Array.isArray(json.pois) ? json.pois : []
  return pois
    .map((p) => {
      const [lon, lat] = String(p.location || '').split(',').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
      const province = String(p.pname || '')
      const cityName = String(p.cityname || '')
      const district = String(p.adname || '')
      return {
        name: String(p.name || ''),
        addr: composeAddr({ province, city: cityName, district, address: p.address }),
        lat, lon, coord: 'gcj',
        province, city: cityName, district,
        distanceFrom: String(p.distance || ''),
      }
    })
    .filter(Boolean)
}

/** 省市区 + 细节拼地址，自动去掉重复片段（高德的道路级 POI 常把 adname 重复进 address） */
function composeAddr(p = {}) {
  const parts = []
  for (const v of [p.province, p.city, p.district, p.address, p.detail]) {
    const t = String(v || '').replace(/\s+/g, '')
    if (!t) continue
    if (parts.some((x) => x.includes(t) || t.includes(x))) continue
    parts.push(t)
  }
  return parts.join('')
}

/**
 * 门牌号精确化：问「宋河东路122号」时高德通常只给「宋河东路100号」「宋河东路126号」这类点，
 * 那就用左右两个门牌按号数线性插值，卡片上的名字仍用用户说的那个门牌号。
 * 没有左右邻居时取号数最接近的那个点；同一条路一个门牌都没有就返回 null，走普通 POI 结果。
 */
function houseNumberFix(q, hits) {
  const m = String(q).match(/(\d{1,5})\s*号/)
  if (!m) return null
  const n = Number(m[1])
  const street = String(q).replace(/\d{1,5}\s*号/, '').trim()
  if (!street) return null
  const esc = street.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const onStreet = []
  for (const h of hits) {
    const hm = String(h.name).match(new RegExp(`${esc}(\\d{1,5})号$`))
    if (hm) onStreet.push({ num: Number(hm[1]), hit: h })
  }
  if (!onStreet.length) return null
  const first = onStreet[0].hit
  const admin = composeAddr({ province: first.province, city: first.city, district: first.district })
  const exact = onStreet.find((x) => x.num === n)
  if (exact) {
    return { name: String(q).trim(), addr: exact.hit.addr, lat: exact.hit.lat, lon: exact.hit.lon, coord: 'gcj', district: exact.hit.district, interpolated: false }
  }
  const lower = onStreet.filter((x) => x.num < n).sort((a, b) => b.num - a.num)[0]
  const higher = onStreet.filter((x) => x.num > n).sort((a, b) => a.num - b.num)[0]
  let lat
  let lon
  if (lower && higher) {
    const t = (n - lower.num) / (higher.num - lower.num)
    lat = lower.hit.lat + (higher.hit.lat - lower.hit.lat) * t
    lon = lower.hit.lon + (higher.hit.lon - lower.hit.lon) * t
  } else {
    const near = [...onStreet].sort((a, b) => Math.abs(a.num - n) - Math.abs(b.num - n))[0]
    lat = near.hit.lat
    lon = near.hit.lon
  }
  return {
    name: String(q).trim(),
    addr: `${admin}${street}${n}号`,
    lat, lon, coord: 'gcj',
    district: first.district,
    interpolated: true,
    basedOn: onStreet.map((x) => `${x.num}号`).join('、'),
  }
}

/** 坐标反查地址（入参必须是 GCJ02，高德要 "lng,lat"） */
async function geoReverse(keys, lat, lon) {
  const { json } = await amapCall('geocode/regeo', {
    location: `${Number(lon).toFixed(6)},${Number(lat).toFixed(6)}`,
    extensions: 'base',
    radius: '200',
  }, keys)
  const r = json.regeocode
  if (!r) throw new Error('逆地理没有结果')
  const ac = r.addressComponent || {}
  const poi = Array.isArray(r.pois) && r.pois.length ? r.pois[0] : null
  return {
    formatted: String(r.formatted_address || ''),
    name: poi ? String(poi.name || '') : '',
    district: String(ac.district || ac.township || ''),
    distance: poi ? String(poi.distance || '') : '',
  }
}

// ---------- 天地图（备用接口，服务器端 tk） ----------
//
// 高德不可用时（没 key / key 失效 / 配额用完）顶上来。三个坑：
//   1) tk 必须是「服务器端」类型，且请求里绝不能带 Referer，否则 403「权限类型错误」(301013)；
//      Node 的 fetch 默认不带 Referer，正好符合。
//   2) 坐标是 CGCS2000（≈WGS84），不是火星坐标，发卡前必须走 gcj() 纠偏。
//   3) 只到「道路 / POI」粒度，不保证有门牌；拿不到就别把精度吹成门牌。

const TDT = 'https://api.tianditu.gov.cn'

async function tdtFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`天地图返回异常（HTTP ${res.status}）`) }
  if (json.code && json.msg) throw new Error(`天地图：${json.msg}`)
  if (String(json.status) !== '0') throw new Error(json.msg || '天地图返回失败')
  return json
}

/** 地址 → 坐标（CGCS2000，发卡前要纠偏） */
async function tdtGeocode(tk, address) {
  const ds = JSON.stringify({ keyWord: address })
  const json = await tdtFetch(`${TDT}/geocoder?ds=${encodeURIComponent(ds)}&tk=${tk}`)
  const loc = json.location
  if (!loc || !loc.lon) throw new Error('天地图没有这个地址')
  return { lat: Number(loc.lat), lon: Number(loc.lon), level: String(loc.level || ''), score: String(loc.score || '') }
}

/** 坐标 → 地址（入参 CGCS2000） */
async function tdtReverse(tk, lat, lon) {
  const postStr = JSON.stringify({ lon: Number(lon), lat: Number(lat), ver: 1 })
  const json = await tdtFetch(`${TDT}/geocoder?postStr=${encodeURIComponent(postStr)}&type=geocode&tk=${tk}`)
  const r = json.result
  if (!r) throw new Error('天地图逆地理没结果')
  return { formatted: String(r.formatted_address || ''), addressComponent: r.addressComponent || {} }
}

/** 关键词查 POI（v2 检索必须要 mapBound，用给定中心点扩一圈） */
async function tdtSearch(tk, keywords, lat, lon) {
  const d = 0.12
  const mapBound = `${(lon - d).toFixed(6)},${(lat - d).toFixed(6)},${(lon + d).toFixed(6)},${(lat + d).toFixed(6)}`
  const postStr = JSON.stringify({ keyWord: keywords, level: 16, mapBound, queryType: 1, start: 0, count: 10 })
  const json = await tdtFetch(`${TDT}/v2/search?postStr=${encodeURIComponent(postStr)}&type=query&tk=${tk}`)
  const pois = Array.isArray(json.pois) ? json.pois : []
  return pois
    .map((p) => {
      const [lon2, lat2] = String(p.lonlat || '').split(',').map(Number)
      if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) return null
      return { name: String(p.name || ''), addr: String(p.address || ''), lat: lat2, lon: lon2, coord: 'wgs', district: '', distanceFrom: '' }
    })
    .filter(Boolean)
}

// ---------- 位置卡片 ----------
//
// 网关自带的 location 段不能用：它拼出来的 com.tencent.map 卡片缺 ver 和 config，
// meta 里字段名也不对，手机端只显示一个空白气泡。
// 下面这个结构是对着一条真实可达的位置卡片逐字段还原出来的：
//   meta['Location.Search'] + ver + config + 32 位 token

/** 把地点拼成一条能渲染的 QQ 位置卡片（json 段） */
function locCard(place, note) {
  // place.coord === 'gcj' 表示坐标已经是火星坐标（高德接口直接返回的就是 GCJ02），不能重复纠偏
  const c = place.coord === 'gcj'
    ? { lat: Number(place.lat), lon: Number(place.lon) }
    : gcj(Number(place.lat), Number(place.lon))
  const address = String(place.addr || '')
    .replace(/^成都\s*/, '四川省成都市')
    .replace(/\s+/g, '')
    .replace(/^四川省成都市四川省成都市/, '四川省成都市')
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
            name: place.name,
            uint64_peer_account: 0,
          },
        },
        prompt: `[位置]${place.name}`,
        ver: '1.1.2.21',
        view: 'LocationShare',
      }),
    },
  }
}

export default {
  id: 'real-loc',
  name: '真实定位卡片',
  version: '1.7.0',
  api: 1,
  description: '把「人在哪儿」用一条能点开地图的真实位置卡片发出去：16 个成都真实点位、WGS84→GCJ02 纠偏、高德为主 + 天地图兜底，支持全国任意地名、门牌号、任意坐标。著作权归「默默相伴澜」专有。',
  tab: 'chat',
  panel: 'panel.js',
  defaults: { enabled: true, amapKey: '', amapKeyBackup: '', tdtTk: '' },
  setup(api) {
    const { hub } = api.core
    const stateFile = join(api.dataDir(), 'state.json')
    const conf = () => {
      try { return api.settings() || {} } catch { return {} }
    }
    // 高德 key：主 key 失效（无效 / 超额 / 被限流）时自动切备用 key。
    // 取值顺序：模块设置 → 环境变量 → 数据目录文件。主 key 用 amap.key / AMAP_KEY / amapKey，
    // 备用 key 用 amap.key2 / AMAP_KEY2 / amapKeyBackup，文件方式可以用 /key 路由一条命令写入。
    const keyFile = join(api.dataDir(), 'amap.key')
    const keyFileBackup = join(api.dataDir(), 'amap.key2')
    const readKeyFile = (file) => {
      try { return String(readFileSync(file, 'utf8')).trim() } catch { return '' }
    }
    const firstOf = (cands) => {
      for (const [value, source] of cands) {
        const t = String(value || '').trim()
        if (t) return { value: t, source }
      }
      return { value: '', source: '' }
    }
    // 一个接口一个 key：主接口只认「主」的三处来源，备用接口只认「备用」的三处来源，
    // 互相不串位（否则备用 key 会被主 key 的文件挤掉，面板上看不出问题）。
    const slotPrimary = () => firstOf([[conf().amapKey, 'settings'], [process.env.AMAP_KEY, 'env'], [readKeyFile(keyFile), 'file']])
    const slotBackup = () => firstOf([[conf().amapKeyBackup, 'settings'], [process.env.AMAP_KEY2, 'env'], [readKeyFile(keyFileBackup), 'file']])
    // 天地图 tk（备用接口）：conf.tdtTk → 环境变量 TIANDITU_TK → 数据目录 tdt.key
    const tdtFile = join(api.dataDir(), 'tdt.key')
    const slotTdt = () => firstOf([[conf().tdtTk, 'settings'], [process.env.TIANDITU_TK, 'env'], [readKeyFile(tdtFile), 'file']])
    const amapKeys = () => [slotPrimary().value, slotBackup().value].filter((k, i, a) => k && a.indexOf(k) === i)
    const amapKey = () => slotPrimary().value
    const tdtKeys = () => [slotTdt().value].filter(Boolean)

    /**
     * 天地图这条线：地理编码定中心 → 带门牌时再搜一圈门牌点插值 → 逆地理补地址。
     * 坐标是 CGCS2000，返回时标 coord:'wgs'，让 locCard 去纠偏，别在这里私自加减。
     */
    async function resolveByTianditu(q, city, tkList) {
      if (!tkList.length) throw new Error('没有可用的天地图 tk')
      let lastError = null
      for (const tk of tkList) {
        try {
          const point = await tdtGeocode(tk, city ? `${city}${q}` : q)
          let fixed = null
          if (/\d{1,5}\s*号/.test(q)) {
            try {
              const hits = await tdtSearch(tk, q, point.lat, point.lon)
              fixed = houseNumberFix(q, hits)
            } catch {}
          }
          const lat = fixed ? fixed.lat : point.lat
          const lon = fixed ? fixed.lon : point.lon
          const rev = await tdtReverse(tk, lat, lon)
          const ac = rev.addressComponent || {}
          const roadName = String(ac.road || ac.address || '').trim()
          // 只说得出道路、又没插值到门牌时，名字退回道路名——不拿「122号」冒充一个只到道路级的点
          const name = fixed || !/\d{1,5}\s*号/.test(q) ? String(q).trim() : (roadName || String(q).trim())
          return {
            spot: { name, addr: rev.formatted || (city ? `${city}${q}` : q), lat, lon, coord: 'wgs' },
            verified: true,
            from: 'tianditu',
            accuracy: point.level,
            houseNumber: fixed ? { interpolated: fixed.interpolated, basedOn: fixed.basedOn || '' } : null,
            askedName: String(q).trim(),
          }
        } catch (error) {
          lastError = error
        }
      }
      throw lastError || new Error('天地图查询失败')
    }

    function load() {
      try {
        const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (raw && typeof raw.place === 'string') return raw
      } catch {}
      return { place: HOME }
    }
    function save(st) {
      try { mkdirSync(api.dataDir(), { recursive: true }); writeFileSync(stateFile, JSON.stringify(st)) } catch {}
    }
    let state = load()
    const current = () => PLACES[state.place] ? { id: state.place, ...PLACES[state.place] } : { id: HOME, ...PLACES[HOME] }

    /** 发一张位置卡到指定会话；返回实际落点（已纠偏） */
    async function send(chatId, place, note) {
      const seg = locCard(place, note)
      await hub.sendSegments(chatId, [seg], `[定位] ${place.name}`, { throwOnError: true })
      const body = JSON.parse(seg.data.data)
      const point = body.meta['Location.Search']
      return { seg, lat: point.lat, lon: point.lng, address: point.address, name: place.name }
    }

    /** 挑活跃会话：优先私聊 */
    function targetChat() {
      const chats = Object.keys(hub.sessions?.() || {})
      return chats.find((id) => id.startsWith('private:')) || chats[0] || ''
    }

    /**
     * 解析「要发的地方」：
     *   1) 本地表命中 → 原样用（WGS84）
     *   2) 本地表没有 + 有高德 key → POI 搜索，拿真名、真地址、真坐标（GCJ02）
     *   3) 直接给坐标 → 有 key 就逆地理反查地址；没 key 必须自带 name + addr
     * 解析不出来就返回 error，绝不编一个地址出来。
     */
    async function resolveSpot({ place, lat, lon, name, addr, city } = {}) {
      const hasLat = lat !== undefined && lat !== null && String(lat).trim() !== ''
      const hasLon = lon !== undefined && lon !== null && String(lon).trim() !== ''

      if (hasLat || hasLon) {
        const wLat = Number(lat)
        const wLon = Number(lon)
        if (!Number.isFinite(wLat) || !Number.isFinite(wLon)) return { error: '坐标要两个都给，而且是数字（纬度, 经度）' }
        if (wLat < -90 || wLat > 90 || wLon < -180 || wLon > 180) return { error: `坐标超出范围：${lat}, ${lon}` }
        const keys = amapKeys()
        const tdt = tdtKeys()
        if (keys.length) {
          const g = gcj(wLat, wLon)
          try {
            const rev = await geoReverse(keys, g.lat, g.lon)
            if (rev.formatted) {
              return {
                spot: { name: String(name || '').trim() || rev.name || rev.formatted, addr: String(addr || '').trim() || rev.formatted, lat: wLat, lon: wLon, coord: 'wgs' },
                verified: true, from: 'regeo', regeo: rev,
              }
            }
            if (!tdt.length) return { error: '这个坐标反查不到地址，没敢发；换个坐标，或直接给地名' }
          } catch (error) {
            if (!tdt.length) return { error: `坐标核验失败（${error.message}），没敢发。换个坐标，或改用地名查询` }
          }
        }
        if (tdt.length) {
          try {
            const rev = await tdtReverse(tdt[0], wLat, wLon)
            if (!rev.formatted) return { error: '这个坐标反查不到地址（天地图），没敢发；换个坐标，或直接给地名' }
            return {
              spot: { name: String(name || '').trim() || rev.formatted, addr: String(addr || '').trim() || rev.formatted, lat: wLat, lon: wLon, coord: 'wgs' },
              verified: true, from: 'tianditu-regeo', regeo: rev,
            }
          } catch (error) {
            return { error: `坐标核验失败（${error.message}），没敢发。换个坐标，或改用地名查询` }
          }
        }
        if (!String(name || '').trim() || !String(addr || '').trim()) {
          return { error: '没配高德 key / 天地图 tk 时，直接发坐标必须自己写 name 和 addr，否则卡片上只有一个空地址；或者改用本地已有的地名' }
        }
        return { spot: { name: String(name).trim(), addr: String(addr).trim(), lat: wLat, lon: wLon, coord: 'wgs' }, verified: false, from: 'manual' }
      }

      const q = String(place || '').trim()
      if (!q) return { spot: current(), verified: false, from: 'current' }

      const local = resolvePlace(q)
      if (local) return { spot: local, verified: false, from: 'local' }

      const keys = amapKeys()
      const tdt = tdtKeys()
      if (!keys.length && !tdt.length) return { error: `本地表里没有「${q}」，而且没配高德 key、也没配天地图 tk，查不了全国。能发的本地点：${Object.values(PLACES).map((x) => x.name).join('、')}` }
      if (keys.length) {
        try {
          const hits = await poiFind(keys, q, city)
          if (!hits.length) {
            if (!tdt.length) return { error: `高德也查不到「${q}」。换个更具体的名字，比如加上城市或区名` }
          } else {
            // 带门牌号的地址：先试插值，插出来的点再反查一次地址把街道/乡镇补齐
            const fixed = houseNumberFix(q, hits)
            if (fixed) {
              let addr = fixed.addr
              try {
                const rev = await geoReverse(keys, fixed.lat, fixed.lon)
                const streetName = String(fixed.name).replace(/\d{1,5}\s*号/, '')
                if (rev.formatted && rev.formatted.includes(streetName)) addr = rev.formatted
              } catch {}
              return {
                spot: { name: fixed.name, addr, lat: fixed.lat, lon: fixed.lon, coord: 'gcj' },
                verified: true, from: 'amap-house',
                houseNumber: { interpolated: fixed.interpolated, basedOn: fixed.basedOn || '' },
                candidates: hits.slice(0, 5),
              }
            }
            return { spot: hits[0], verified: true, from: 'amap', candidates: hits.slice(0, 5) }
          }
        } catch (error) {
          if (!tdt.length) return { error: `地名查询没成功：${error.message}` }
        }
      }
      // 高德这条路没结果 / 出错了 → 天地图兜底
      try {
        return await resolveByTianditu(q, city, tdt)
      } catch (error) {
        return { error: `天地图也查不到「${q}」：${error.message}。换个更具体的名字，比如加上城市或区名` }
      }
    }

    api.tool(({ chat, sessionId }) => (api.settings().enabled && chat.kind !== 'system' ? [
      api.defineTool({
        name: 'loc_send',
        description: '把位置发成一条真的位置卡片（手机点开就是地图，不是链接、不是截图）。有人问「你在哪」、想让他过来找你、或者你想让他看看这地方的时候用。'
          + '默认发当前所在地；也可以指定别的地方名（本地表没有的会联网查真地名，需要配高德 key 或天地图 tk），或者直接给坐标（会反查地址，查不实就不发）。',
        properties: {
          place: { type: 'string', description: '地名或 id（省略＝当前所在地）。比如「合江亭河边」「太古里」「river」，也可以是全国任意地名如「西安钟楼」「广州塔」' },
          city: { type: 'string', description: '地名重名时用，限定城市（可选），比如「成都」「西安」' },
          lat: { type: 'number', description: '纬度（WGS84，可选）。只有当你知道确切坐标、或想发一个不在任何地名表里的点时用；给了坐标会联网反查地址' },
          lon: { type: 'number', description: '经度（WGS84，可选）。和 lat 一起给' },
          name: { type: 'string', description: '坐标模式下卡片上显示的名字（可选，默认用反查到的地名；没配高德 key 时必填）' },
          addr: { type: 'string', description: '坐标模式下卡片上显示的地址（可选，默认用反查到的地址；没配高德 key 时必填）' },
          note: { type: 'string', description: '卡片上附一句话（可选），比如「我在河边等你」「刚到这」' },
        },
        execute: async ({ place, city, lat, lon, name, addr, note } = {}) => {
          if (chat.kind === 'group' && !hub.turnSendersAllOwner(sessionId)) {
            return { ok: false, message: '群里不是主人开口，不暴露位置' }
          }
          const r = await resolveSpot({ place, lat, lon, name, addr, city })
          if (r.error) return { ok: false, message: r.error }
          const spot = r.spot
          if (spot.id) {
            state = { ...state, place: spot.id }
            save(state)
          }
          try {
            const chatId = chat.chatId || targetChat()
            if (!chatId) return { ok: false, message: '没有活跃会话能发定位' }
            const sent = await send(chatId, spot, note)
            const how = r.from === 'amap' ? '地址来自高德'
              : r.from === 'amap-house' ? '地址来自高德，门牌号按同路左右号插值'
                : r.from === 'tianditu' ? `高德没接住，这次用天地图查的（${r.accuracy || '道路'}级精度${r.houseNumber ? '，门牌按同路左右号插值' : ''}）`
                  : r.from === 'tianditu-regeo' ? '高德没接住，坐标用天地图反查的'
                    : r.from === 'regeo' ? '坐标已反查成地址'
                      : r.from === 'manual' ? '地址是你自己给的、没联网核验' : '本地坐标表'
            return {
              ok: true,
              message: `定位发出去了：${spot.name}（${sent.address}｜${sent.lat}, ${sent.lon}）。${how}，他那边点开就是地图。`,
              place: spot.id || '', name: spot.name, lat: sent.lat, lon: sent.lon, address: sent.address,
              verified: r.verified, source: r.from, target: chatId,
            }
          } catch (error) {
            return { ok: false, message: `定位没发出去：${error?.message || '网关不接受'}。照实说没发成，别假装发过了。` }
          }
        },
      }),
    ] : []))

    // 当前地点（给别的模块读）
    api.route('/here', () => ({ ok: true, place: current() }))

    // 地点表：核对坐标用
    api.route('/places', () => ({
      ok: true,
      list: Object.entries(PLACES).map(([id, p]) => {
        const c = gcj(p.lat, p.lon)
        return { id, name: p.name, wgs84: [p.lat, p.lon], gcj02: [Number(c.lat.toFixed(6)), Number(c.lon.toFixed(6))], addr: p.addr }
      }),
    }))

    // 手动发一次：/loc?place=river&note=...  或  /loc?lat=30.6487&lon=104.0866&name=&addr=
    api.route('/loc', async (req) => {
      let place = ''
      let note = ''
      let city = ''
      let lat = ''
      let lon = ''
      let name = ''
      let addr = ''
      try {
        const q = api.core.http.query(req)
        place = String(q.place || '')
        note = String(q.note || '')
        city = String(q.city || '')
        lat = String(q.lat || '')
        lon = String(q.lon || '')
        name = String(q.name || '')
        addr = String(q.addr || '')
      } catch {}
      const r = await resolveSpot({ place, lat, lon, name, addr, city })
      if (r.error) return { ok: false, message: r.error }
      const chatId = targetChat()
      if (!chatId) return { ok: false, message: '没有活跃会话能发' }
      try {
        const sent = await send(chatId, r.spot, note)
        return {
          ok: true, target: chatId, place: r.spot.name, lat: sent.lat, lon: sent.lon, address: sent.address,
          verified: r.verified, source: r.from, segment: sent.seg,
        }
      } catch (error) {
        return { ok: false, message: `没发出去：${error?.message || '网关拒绝'}` }
      }
    })

    // 只查不发：/lookup?keywords=西安钟楼&city=西安 —— 用来验 key、看候选，不产生任何消息
    api.route('/lookup', async (req) => {
      let keywords = ''
      let city = ''
      try {
        const q = api.core.http.query(req)
        keywords = String(q.keywords || q.q || '')
        city = String(q.city || '')
      } catch {}
      if (!keywords) return { ok: false, message: '给个地名，比如 /lookup?keywords=西安钟楼' }
      const local = resolvePlace(keywords)
      if (local) return { ok: true, from: 'local', candidate: local }
      const keys = amapKeys()
      const tdt = tdtKeys()
      if (!keys.length && !tdt.length) return { ok: false, message: '没配高德 key、也没配天地图 tk（/key 可写），只能查本地表' }
      if (keys.length) {
        try {
          const hits = await poiFind(keys, keywords, city)
          if (hits.length) return { ok: true, from: 'amap', count: hits.length, candidates: hits }
        } catch (error) {
          if (!tdt.length) return { ok: false, message: `查询失败：${error.message}` }
        }
      }
      try {
        const pt = await tdtGeocode(tdt[0], city ? `${city}${keywords}` : keywords)
        let rev = null
        try { rev = await tdtReverse(tdt[0], pt.lat, pt.lon) } catch {}
        let hits = []
        try { hits = await tdtSearch(tdt[0], keywords, pt.lat, pt.lon) } catch {}
        return {
          ok: true, from: 'tianditu', provider: '天地图',
          accuracy: pt.level,
          point: { lon: pt.lon, lat: pt.lat, coord: 'cgcs2000' },
          address: rev ? rev.formatted : '',
          count: hits.length,
          candidates: hits,
        }
      } catch (error) {
        return { ok: false, message: `查询失败（${error.message}）` }
      }
    })

    // key 热配置：/key?value=xxx&slot=primary|backup|tdt（slot 省略＝primary，兼容旧的 ?backup=1 / ?tdt=1），
    // /key?clear=1&slot=… 清除，/key?clearfile=1&slot=… 只删数据目录里的文件（面板写完设置时用），
    // /key 只看状态：每个接口只回自己的后四位与来源，不串位。
    api.route('/key', (req) => {
      let value = ''
      let clear = false
      let clearFile = false
      let slot = ''
      try {
        const q = api.core.http.query(req)
        value = String(q.value || q.key || '').trim()
        clear = String(q.clear || '') === '1'
        clearFile = String(q.clearfile || '') === '1'
        slot = String(q.slot || '')
        if (!slot) slot = String(q.tdt || '') === '1' ? 'tdt' : (String(q.backup || '') === '1' ? 'backup' : 'primary')
      } catch {}
      if (!['primary', 'backup', 'tdt'].includes(slot)) slot = 'primary'
      const SLOTS = {
        primary: { file: keyFile, setting: 'amapKey', label: '高德主 Key' },
        backup: { file: keyFileBackup, setting: 'amapKeyBackup', label: '高德备用 Key' },
        tdt: { file: tdtFile, setting: 'tdtTk', label: '天地图 tk' },
      }
      const tail = (k) => (k ? `…${k.slice(-4)}` : '')
      const status = () => {
        const p = { primary: slotPrimary(), backup: slotBackup(), tdt: slotTdt() }
        const slots = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { set: !!v.value, tail: tail(v.value), source: v.source }]))
        return {
          ok: true,
          hasKey: !!p.primary.value, tail: tail(p.primary.value), keySource: p.primary.source,
          hasBackup: !!p.backup.value, backupTail: tail(p.backup.value), backupSource: p.backup.source,
          hasTdt: !!p.tdt.value, tdtTail: tail(p.tdt.value), tdtSource: p.tdt.source,
          amapCount: amapKeys().length, tdtCount: tdtKeys().length,
          slots,
        }
      }
      const s = SLOTS[slot]
      if (clearFile) {
        try { rmSync(s.file, { force: true }) } catch {}
        return { ...status(), clearedFile: slot }
      }
      if (clear) {
        try { rmSync(s.file, { force: true }) } catch {}
        try { api.saveSettings({ [s.setting]: '' }) } catch {}
        return { ...status(), cleared: slot }
      }
      if (value) {
        if (!/^[0-9a-zA-Z]{24,64}$/.test(value)) return { ok: false, message: `${s.label} 格式不对（应为 32 位字母数字）` }
        // 只为这个接口这一个位置写值：写进模块设置，同时删掉数据目录里的旧文件，免得两处打架
        try { api.saveSettings({ [s.setting]: value }) } catch (error) {
          return { ok: false, message: `写不进模块设置：${error?.message || '未知原因'}` }
        }
        try { rmSync(s.file, { force: true }) } catch {}
        return { ...status(), wrote: slot, wroteTail: tail(value) }
      }
      return status()
    })

    // 自检：三把 key/tk 各自单独打一次，谁通谁不通一眼看出来（不产生任何消息）
    api.route('/selfcheck', async (req) => {
      let keywords = '宋河东路122号'
      let city = '温州'
      try {
        const q = api.core.http.query(req)
        if (q.keywords) keywords = String(q.keywords)
        if (q.city) city = String(q.city)
      } catch {}
      const out = {}
      const check = async (name, fn) => {
        try { out[name] = await fn() } catch (error) { out[name] = { ok: false, error: String(error?.message || error) } }
      }
      await check('primary', async () => {
        const k = slotPrimary().value
        if (!k) return { ok: false, skipped: '没填' }
        const hits = await poiFind([k], keywords, city)
        return { ok: true, count: hits.length, first: hits[0]?.name || '' }
      })
      await check('backup', async () => {
        const k = slotBackup().value
        if (!k) return { ok: false, skipped: '没填' }
        const hits = await poiFind([k], keywords, city)
        return { ok: true, count: hits.length, first: hits[0]?.name || '' }
      })
      await check('tdt', async () => {
        const k = slotTdt().value
        if (!k) return { ok: false, skipped: '没填' }
        const pt = await tdtGeocode(k, `${city}${keywords}`)
        return { ok: true, level: pt.level, point: `${pt.lat},${pt.lon}` }
      })
      return { ok: true, keywords, city, slots: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { ...v }])) }
    })

    // 授权状态：这条是「配套专属验证特性」的可查入口
    api.route('/lic', () => ({
      ok: true,
      work: LICENSE.work,
      holder: LICENSE.holder,
      edition: LICENSE.edition,
      issuedAt: LICENSE.issuedAt,
      sealOk: true,
      terms: LICENSE.terms,
      verify: '加密正文需著作权人专属解密代码，用 verify/verify.mjs 校验',
    }))
  },
}
