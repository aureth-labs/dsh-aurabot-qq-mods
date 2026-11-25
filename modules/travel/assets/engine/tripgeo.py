# -*- coding: utf-8 -*-
"""出行位置引擎：高德路线（走/骑/驾车/公交）+ 12306（火车/高铁），
按「现在几点」把位置推到路线上的某一点，绝不随机。

CLI：
  python tripgeo.py plan train 成都西 广元 2026-11-18
  python tripgeo.py plan drive 成都 德阳
  python tripgeo.py where train 成都西 广元 2026-11-18 "2026-11-19 01:05"
"""
import sys, json, os, math, argparse, urllib3, requests
from datetime import datetime, timedelta, timezone
urllib3.disable_warnings()
BASE = os.environ.get('TRAVEL_TMP') or os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import rail
import rail_plan

CFG = os.environ.get('AURABOT_CONFIG') or os.path.join(
    os.path.expanduser('~'), '.dsh', 'plugins-data', 'aurabot', 'config.json')
KEY_BACKUP = ''
try:
    _cfg = json.load(open(CFG, encoding='utf-8-sig'))
    _ext = _cfg.get('ext', {}) or {}
    _t = _ext.get('travel', {}) or {}
    _old = _ext.get('real-loc', {}) or {}
    # 合并后 key 在 ext.travel.real_amapKey；旧 ext['real-loc'] 仅作兼容回退
    KEY = _t.get('real_amapKey') or _old.get('amapKey', '') or os.environ.get('AMAP_KEY', '')
    # 备用 key：主 key 当天额度打满就自动切过去，不至于整天不能用
    KEY_BACKUP = _t.get('real_amapKeyBackup') or _old.get('amapKeyBackup', '') or ''
except Exception:
    KEY = os.environ.get('AMAP_KEY', '')
_USING_BACKUP = False
S = requests.Session()
_GEO, _ROUTE = {}, {}
CT = timezone(timedelta(hours=8))   # 中国境内一律 +8

# ---------- 落盘缓存：省高德调用（进程每次都是新的，内存缓存跨不过去） ----------
_BASE = os.environ.get('TRIPGEO_CACHE_DIR') or os.path.dirname(os.path.abspath(__file__))
_GEO_FILE = os.path.join(_BASE, '.geo-cache.json')      # 地名 → 坐标，30 天
_ROUTE_FILE = os.path.join(_BASE, '.route-cache.json')  # 两点间折线，7 天
_REGEO_FILE = os.path.join(_BASE, '.regeo-cache.json')  # 坐标 → 地址，30 天
_STAT_FILE = os.path.join(_BASE, '.amap-stats.json')    # 当日调用计数
_GEO_TTL, _ROUTE_TTL, _REGEO_TTL = 30 * 86400, 7 * 86400, 30 * 86400
AMAP_DAILY_BUDGET = int(os.environ.get('AMAP_DAILY_BUDGET') or 600)
_MEM = {'geo': None, 'route': None, 'regeo': None, 'dirty': False}


def _disk_load(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _disk_save(path):
    d = _MEM[_key_of(path)]
    if not isinstance(d, dict):
        return
    try:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass


def _key_of(path):
    return {_GEO_FILE: 'geo', _ROUTE_FILE: 'route', _REGEO_FILE: 'regeo'}.get(path, 'geo')


def _mem(path):
    k = _key_of(path)
    if _MEM[k] is None:
        _MEM[k] = _disk_load(path)
    return _MEM[k]


def _hit(path, key, ttl):
    e = _mem(path).get(key)
    if not e:
        return None
    if time.time() - float(e.get('ts') or 0) > ttl:
        return None
    return e.get('v')


def _put(path, key, val, ttl):
    _mem(path)[key] = {'ts': time.time(), 'v': val}
    _MEM['dirty'] = True


def _flush():
    if not _MEM['dirty']:
        return
    for p in (_GEO_FILE, _ROUTE_FILE, _REGEO_FILE):
        _disk_save(p)
    _MEM['dirty'] = False


import atexit, time
atexit.register(_flush)


def _stat_bump():
    """当日高德调用计数：既用来算预算，也用来看「为什么额度掉这么快」"""
    d = _disk_load(_STAT_FILE)
    day = datetime.now(CT).strftime('%Y-%m-%d')
    if str(d.get('day')) != day:
        d = {'day': day, 'n': 0}
    d['n'] = int(d.get('n') or 0) + 1
    try:
        with open(_STAT_FILE, 'w', encoding='utf-8') as f:
            json.dump(d, f)
    except Exception:
        pass
    if d['n'] > AMAP_DAILY_BUDGET:
        raise RuntimeError(f'今天高德已调用 {d["n"]} 次，超过自设预算 {AMAP_DAILY_BUDGET} 次；'
                           f'为了不打满免费额度先停手，明天再走，或把 AMAP_DAILY_BUDGET 调高/换付费 key')
    return d['n']


def amap_used_today():
    d = _disk_load(_STAT_FILE)
    return int(d.get('n') or 0) if str(d.get('day')) == datetime.now(CT).strftime('%Y-%m-%d') else 0
CHINA_BOX = (73.5, 18.0, 135.1, 53.6)


CITY_TZ = {
    '北京': 8, '上海': 8, '广州': 8, '成都': 8, '重庆': 8, '深圳': 8, '香港': 8, '澳门': 8, '台北': 8,
    '东京': 9, '大阪': 9, '首尔': 9, '新加坡': 8, '吉隆坡': 8, '曼谷': 7, '雅加达': 7, '马尼拉': 8,
    '迪拜': 4, '多哈': 3, '莫斯科': 3, '伊斯坦布尔': 3, '新德里': 5.5, '孟买': 5.5,
    '法兰克福': 1, '柏林': 1, '巴黎': 1, '阿姆斯特丹': 1, '罗马': 1, '苏黎世': 1, '马德里': 1,
    '伦敦': 0, '都柏林': 0, '里斯本': 0,
    '纽约': -5, '华盛顿': -5, '波士顿': -5, '芝加哥': -6, '丹佛': -7,
    '洛杉矶': -8, '旧金山': -8, '西雅图': -8, '温哥华': -8,
    '悉尼': 10, '墨尔本': 10, '奥克兰': 12,
}


def tz_hours(lat, lon, hint=''):
    """行程用「所在地」时区：先认地名，再看中国境内，最后按经度取整（境外只是近似）"""
    s = str(hint or '')
    for k, v in CITY_TZ.items():
        if k in s:
            return v
    if lat is None or lon is None:
        return 8
    if CHINA_BOX[0] <= lon <= CHINA_BOX[2] and CHINA_BOX[1] <= lat <= CHINA_BOX[3]:
        return 8
    return max(-12, min(14, int(round(lon / 15.0))))


def in_china(lat, lon):
    return lat is not None and lon is not None and \
        CHINA_BOX[0] <= lon <= CHINA_BOX[2] and CHINA_BOX[1] <= lat <= CHINA_BOX[3]


def _need_china(lat, lon, label):
    """硬边界：只在国境内活动，境外坐标一律不走"""
    if not in_china(lat, lon):
        raise RuntimeError(f'{label} 在境外（{lat},{lon}），我只在国内活动，出不了国')
    # 港澳台：POI 能搜到，但高德跨境路径接口给的是「海外每日查询超限」，走不出真实路线，所以不放开
    if any(k in str(label) for k in ('香港', '澳门', '澳門', '台湾', '臺灣')):
        raise RuntimeError(f'{label} 属跨境（港澳台），高德现在不提供真实路径（海外查询额度受限），这段走不了')


def now_in(hours):
    """该地区此刻的墙钟（naive），不读本机时区"""
    return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=hours)


def now_ct():
    return now_in(8)


class AmapQuotaError(RuntimeError):
    """额度过限：必须一路抛出去，绝不能被「没搜到 → 换关键词再试」的逻辑吞掉"""


_EXHAUST_FILE = os.path.join(_BASE, '.amap-exhausted.json')


def _exhausted_today(path=''):
    """今天这个接口的额度已经打满：同一天同一 key 同一接口不再白打。
    必须按接口分开记——高德各接口配额是分开的（POI 搜索 100/日，地理编码 5000/日），
    一个接口满了不代表别的接口也满。"""
    d = _disk_load(_EXHAUST_FILE)
    if str(d.get('day')) != datetime.now(CT).strftime('%Y-%m-%d') or str(d.get('key')) != str(KEY)[-6:]:
        return False
    svc = str(d.get('svc') or '*')
    return svc in ('*', str(path))


def _mark_exhausted(info, path=''):
    try:
        with open(_EXHAUST_FILE, 'w', encoding='utf-8') as f:
            json.dump({'day': datetime.now(CT).strftime('%Y-%m-%d'),
                       'key': str(KEY)[-6:], 'svc': str(path), 'info': str(info)}, f)
    except Exception:
        pass


def _amap(path, params):
    global KEY, _USING_BACKUP
    try:
        return _amap_once(path, params)
    except AmapQuotaError:
        if KEY_BACKUP and KEY_BACKUP != KEY and not _USING_BACKUP:
            # 主 key 当天额度打满：切备用 key 再试一次（换了 key 那天的「已打满」标记就不算数）
            KEY = KEY_BACKUP
            _USING_BACKUP = True
            try:
                os.remove(_EXHAUST_FILE)
            except Exception:
                pass
            return _amap_once(path, params)
        raise


def _amap_once(path, params):
    if _exhausted_today(path):
        raise AmapQuotaError(f'高德 {path} 今日额度已打满（同一 key 今天不再试这个接口），'
                             f'这属于外部额度问题，不是路线算不出来；明天 0:00 自动恢复，或换一把付费 key')
    _stat_bump()
    p = dict(params, key=KEY)
    r = S.get(f'https://restapi.amap.com/v3/{path}', params=p, timeout=25)
    j = r.json()
    if str(j.get('status')) != '1':
        info = str(j.get('info') or '')
        if 'OVER_LIMIT' in info or str(j.get('infocode')) in ('10003', '10044', '10045'):
            _mark_exhausted(info, path)
            raise AmapQuotaError(f'高德 {path} 失败: {info}（这个接口今天额度用完了，不是代码问题；'
                                 f'明天 0:00 恢复，或换付费 key）')
        raise RuntimeError(f'高德 {path} 失败: {j.get("info")} ({j.get("infocode")})')
    return j


def _geo_geo(name, city=None):
    """地理编码：5000 次/日（POI 搜索只有 100 次/日），站名/机场/地名都能落到坐标，优先用这个"""
    for addr in ([name] if str(name).endswith(('站', '机场')) else [name + '站', name]):
        params = {'address': addr}
        if city:
            params['city'] = city
        try:
            j = _amap('geocode/geo', params)
        except RuntimeError:
            continue
        gs = j.get('geocodes') or []
        if not gs:
            continue
        g = gs[0]
        loc = g.get('location') or ''
        if ',' not in loc:
            continue
        lon, lat = loc.split(',')
        return {'name': name, 'lat': float(lat), 'lon': float(lon),
                'addr': g.get('formatted_address', ''), 'city': g.get('city') or '',
                'adname': g.get('district') or '', 'level': g.get('level') or ''}
    return None


def _poi(name, city=None, prefer_city=None):
    """POI 精确搜：可带城市锚定；站名优先站、机场名优先机场、其余按名字；match_city 只做软偏好"""
    kws = [name]
    if not name.endswith('站') and not name.endswith('机场'):
        kws = [name + '站', name]
    cands = []
    for kw in kws:
        params = {'keywords': kw, 'offset': 8, 'extensions': 'base'}
        if city:
            params['city'] = city
            params['citylimit'] = 'true'
        try:
            j = _amap('place/text', params)
        except AmapQuotaError:
            # POI 搜索日配额（个人开发者只有 100 次/日）打满时，降级到地理编码接口（5000 次/日）
            g = _geo_geo(name)
            if g:
                return g
            raise
        except RuntimeError:
            continue
        for p in (j.get('pois') or []):
            loc = p.get('location') or ''
            if not loc:
                continue
            t = p.get('type') or ''
            pn = p.get('name') or ''
            pc = p.get('cityname') or ''
            adx = pc + (p.get('adname') or '') + (p.get('address') or '')
            # 港澳台：能搜到 POI，但高德跨境路径接口给「海外查询额度超限」，真实路线拿不到，直接不收
            if any(k in adx for k in ('香港', '澳门', '澳門', '台湾', '臺灣')):
                continue
            score = 0
            if '火车站' in t:
                score += 12
            elif '交通设施服务' in t:
                score += 6
            if '机场' in name and '机场' in t:
                score += 14
            if pn == name or pn == kw:
                score += 5
            if kw.endswith('站') and pn.endswith('站'):
                score += 3
            if prefer_city and pc == prefer_city:
                score += 10
            lon, lat = loc.split(',')
            cands.append((score, pn or name, float(lat), float(lon),
                          pc + (p.get('adname') or '') + (p.get('address') or ''), pc, p.get('adname') or '', t))
        # 第一个关键词就打到火车站/机场（分数够高）就不再补第二个词：一次请求够用就别打两次
        if cands and max(c[0] for c in cands) >= 12:
            break
    if not cands:
        return None
    cands.sort(key=lambda x: -x[0])
    s1, n1, la1, lo1, ad1, c1, d1, t1 = cands[0]
    best = {'name': n1, 'lat': la1, 'lon': lo1, 'addr': ad1, 'city': c1, 'adname': d1, 'poi_type': t1}
    # 同名/近似同名、分数咬得紧、位置又差得远：别猜，先问
    if len(cands) > 1:
        s2, n2, la2, lo2, ad2 = cands[1][:5]
        if s1 - s2 <= 3 and n2 != n1:
            try:
                far = _dist_km(la1, lo1, la2, lo2)
            except Exception:
                far = 0
            if far > 8:
                best['ambiguous'] = [
                    {'name': n1, 'addr': ad1, 'lat': la1, 'lon': lo1},
                    {'name': n2, 'addr': ad2, 'lat': la2, 'lon': lo2},
                ]
    return best


def _guard_ambiguous(g, label):
    c = (g or {}).get('ambiguous')
    if c:
        opts = '；'.join(f'{x["name"]}（{str(x["addr"])[:20]}）' for x in c[:2])
        raise RuntimeError(f'「{label}」有两个都对得上：{opts}。你说的是哪个？说清楚我再安排。')


def geocode(name, city=None, prefer_city=None):
    key = (name, city or '', prefer_city or '')
    if key in _GEO:
        return _GEO[key]
    ck = '|'.join(key)
    hit = _hit(_GEO_FILE, ck, _GEO_TTL)
    if hit:
        _GEO[key] = hit
        return hit
    if prefer_city and not city:
        # 「同城优先」只是排序偏好：不锚定城市时先蹭不带偏好的缓存，免得同一个地名再打一次高德
        plain = _hit(_GEO_FILE, f'{name}||', _GEO_TTL)
        if plain and str(plain.get('city') or '').replace('市', '') == str(prefer_city).replace('市', ''):
            _GEO[key] = plain
            return plain
    if '@' in name:
        # 「名字@纬度,经度」：境外高德查不到时由人直接给坐标
        nm, ll = name.split('@', 1)
        lat, lon = [float(x) for x in ll.split(',')]
        _GEO[key] = {'name': nm.strip(), 'lat': lat, 'lon': lon, 'addr': '手填坐标',
                     'city': '', 'adname': '', 'manual': True}
        return _GEO[key]
    # 站/机场这类高频目标先走地理编码（5000 次/日），省下 POI 那 100 次/日给真正需要候选的场合
    if str(name).endswith(('站', '机场')) or '机场' in str(name):
        g = _geo_geo(name, city)
        if g:
            _GEO[key] = g
            _put(_GEO_FILE, ck, g, _GEO_TTL)
            return g
    p = _poi(name, city, prefer_city)
    if p:
        _GEO[key] = p
        if not p.get('ambiguous'):
            _put(_GEO_FILE, ck, p, _GEO_TTL)      # 真定下来的坐标才存：以后不再问高德
        return p
    for addr in (name + '站', name + '火车站', name):
        j = _amap('geocode/geo', {'address': addr})
        if j.get('geocodes'):
            g = j['geocodes'][0]
            lon, lat = g['location'].split(',')
            _GEO[key] = {'name': name, 'lat': float(lat), 'lon': float(lon),
                         'addr': g.get('formatted_address', ''), 'city': '', 'adname': ''}
            _put(_GEO_FILE, ck, _GEO[key], _GEO_TTL)
            return _GEO[key]
    raise RuntimeError(f'高德查不到坐标: {name}')


def regeo(lat, lon):
    # 2 位小数（约 1km）：同一区间反复问位置能命中同一条地址，少打高德；坐标本身仍是精确的
    ck = f'{round(float(lat), 2)},{round(float(lon), 2)}'
    hit = _hit(_REGEO_FILE, ck, _REGEO_TTL)
    if hit is not None:
        return hit
    j = _amap('geocode/regeo', {'location': f'{lon},{lat}', 'radius': 1000, 'extensions': 'base'})
    addr = (j.get('regeocode') or {}).get('formatted_address', '')
    _put(_REGEO_FILE, ck, addr, _REGEO_TTL)
    return addr


def _iv(v, d=0):
    try:
        if isinstance(v, list):
            v = v[0] if v else d
        return int(float(v))
    except Exception:
        return d


def _polyline(s):
    return [tuple(map(float, p.split(','))) for p in s.split(';') if p]


def airport(q):
    """高德只能给机场坐标：用 POI 搜「XX机场」；境外机场高德搜不到，可写成「名字@纬度,经度」直接给坐标"""
    if '@' in q:
        name, ll = q.split('@', 1)
        lat, lon = [float(x) for x in ll.split(',')]
        return {'name': name.strip(), 'lat': lat, 'lon': lon, 'addr': '手填坐标', 'poi': 'manual'}
    kw = q if '机场' in q else q + '机场'
    ak = 'air|' + kw
    hit = _hit(_GEO_FILE, ak, _GEO_TTL)
    if hit:
        return hit
    # 机场优先 POI（能给真正的「机场」POI，登机牌坐标更准）；POI 额度满了再退地理编码
    try:
        j = _amap('place/text', {'keywords': kw, 'offset': 3, 'extensions': 'base'})
    except AmapQuotaError:
        g = _geo_geo(kw)
        if not g:
            raise
        out = {'name': g['name'], 'lat': g['lat'], 'lon': g['lon'],
               'addr': g.get('addr') or '', 'poi': 'geo'}
        _put(_GEO_FILE, ak, out, _GEO_TTL)
        return out
    pois = j.get('pois') or []
    if not pois:
        j = _amap('place/text', {'keywords': kw, 'city': q, 'offset': 3})
        pois = j.get('pois') or []
    if not pois:
        raise RuntimeError(f'高德搜不到机场: {kw}')
    p = pois[0]
    lon, lat = p['location'].split(',')
    out = {'name': p['name'], 'lat': float(lat), 'lon': float(lon),
           'addr': f"{p.get('cityname', '')}{p.get('adname', '')}", 'poi': p.get('type', '')}
    _put(_GEO_FILE, ak, out, _GEO_TTL)
    return out


def _gc_point(a, b, f):
    """大圆航线插值：给定起降机场与进度 0..1，返回机上所在点（经纬度）"""
    la1, lo1, la2, lo2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    d = 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2
                                + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
    if d == 0:
        return a['lat'], a['lon']
    A = math.sin((1 - f) * d) / math.sin(d)
    B = math.sin(f * d) / math.sin(d)
    x = A * math.cos(la1) * math.cos(lo1) + B * math.cos(la2) * math.cos(lo2)
    y = A * math.cos(la1) * math.sin(lo1) + B * math.cos(la2) * math.sin(lo2)
    z = A * math.sin(la1) + B * math.sin(la2)
    lat = math.degrees(math.atan2(z, math.hypot(x, y)))
    lon = math.degrees(math.atan2(y, x))
    return lat, lon


def flight_trip(fr, to, depart, arrive):
    """飞机：高德给机场坐标，位置按大圆航线 + 时间进度插值（需自行给班次时刻）
    起降时刻按各自机场所在地区时间给，内部统一折算到出发地时区再算时长"""
    a = airport(fr)
    b = airport(to)
    _need_china(a['lat'], a['lon'], fr)
    _need_china(b['lat'], b['lon'], to)
    tz_dep, tz_arr = tz_hours(a['lat'], a['lon'], fr), tz_hours(b['lat'], b['lon'], to)
    d1 = datetime.strptime(depart, '%Y-%m-%d %H:%M')
    d2 = datetime.strptime(arrive, '%Y-%m-%d %H:%M') + timedelta(hours=tz_dep - tz_arr)
    while d2 < d1:
        d2 += timedelta(days=1)
    return {'mode': 'flight', 'from': a['name'], 'to': b['name'],
            'from_airport': a, 'to_airport': b, 'depart': d1, 'arrive': d2,
            'duration_s': int((d2 - d1).total_seconds()), '_tz': tz_dep,
            'tz_from': tz_dep, 'tz_to': tz_arr, '_start': d1}


def road_route(mode, fr, to, city=None):
    """driving / walking / bicycling -> 折线 + 各步累计时长；境外高德没数据就按直线+均速估算"""
    a = geocode(fr, city)
    b = geocode(to, city, prefer_city=None if city else (a.get('city') or None))
    _guard_ambiguous(a, fr)
    _guard_ambiguous(b, to)
    tz = tz_hours(a['lat'], a['lon'], fr)
    _need_china(a['lat'], a['lon'], fr)
    _need_china(b['lat'], b['lon'], to)
    api = {'drive': 'direction/driving', 'walk': 'direction/walking',
           'bike': 'direction/bicycling'}[mode]
    rk = f'{mode}|{round(a["lon"], 4)},{round(a["lat"], 4)}|{round(b["lon"], 4)},{round(b["lat"], 4)}'
    rc = _hit(_ROUTE_FILE, rk, _ROUTE_TTL)
    if rc:
        # 同一条路走过就不再问：折线、耗时、距离都照抄，位置照样只落线上
        return {'mode': mode, 'from': a['name'], 'to': b['name'],
                'points': [tuple(x) for x in rc['points']],
                'duration_s': rc['duration_s'], 'distance_m': rc['distance_m'],
                'amap_from': a, 'amap_to': b, '_tz': tz}
    j = _amap(api, {'origin': f'{a["lon"]},{a["lat"]}',
                    'destination': f'{b["lon"]},{b["lat"]}',
                    'extensions': 'base'})
    path = (j['route']['paths'] or [{}])[0]
    pts, acc, t = [], 0.0, 0
    for st in path.get('steps', []):
        line = _polyline(st['polyline'])
        dur = int(st.get('duration', 0))
        if pts and line:
            line = line[1:]
        pts.extend(line)
        acc += float(st.get('distance', 0) or 0)
        t += dur
    out = {'mode': mode, 'from': a['name'], 'to': b['name'], 'points': pts,
           'duration_s': t or int(path.get('duration', 0)),
           'distance_m': float(path.get('distance', 0)),
           'amap_from': a, 'amap_to': b, '_tz': tz}
    if pts:
        _put(_ROUTE_FILE, rk, {'points': [[p[0], p[1]] for p in pts],
                               'duration_s': out['duration_s'],
                               'distance_m': out['distance_m']}, _ROUTE_TTL)
    return out


def transit_route(fr, to, city):
    a = geocode(fr, city)
    b = geocode(to, city, prefer_city=None if city else (a.get('city') or None))
    _guard_ambiguous(a, fr)
    _guard_ambiguous(b, to)
    _need_china(a['lat'], a['lon'], fr)
    _need_china(b['lat'], b['lon'], to)
    rk = (f'transit|{city}|{round(a["lon"], 4)},{round(a["lat"], 4)}|'
          f'{round(b["lon"], 4)},{round(b["lat"], 4)}')
    rc = _hit(_ROUTE_FILE, rk, _ROUTE_TTL)
    if rc:
        return {'mode': 'transit', 'from': fr, 'to': to,
                'segs': [{'kind': s['kind'], 'points': [tuple(x) for x in s['points']],
                          'duration_s': s['duration_s'], 'name': s['name']} for s in rc['segs']],
                'duration_s': rc['duration_s'], 'distance_m': rc['distance_m'],
                '_tz': tz_hours(a['lat'], a['lon'])}
    j = _amap('direction/transit/integrated', {'origin': f'{a["lon"]},{a["lat"]}',
                                               'destination': f'{b["lon"]},{b["lat"]}',
                                               'city': city, 'cityd': city})
    if not (j.get('route') or {}).get('transits'):
        raise RuntimeError('高德公交只支持同城；跨城请用 train 模式（12306）')
    tr = (j['route']['transits'] or [])[0]
    segs = []
    for seg in tr['segments']:
        if seg.get('walking') and seg['walking'].get('steps'):
            line, dur = [], 0
            for st in seg['walking']['steps']:
                line.extend(_polyline(st.get('polyline', '') or ''))
                dur += _iv(st.get('duration'))
            segs.append({'kind': 'walk', 'points': line, 'duration_s': dur, 'name': '步行'})
        if seg.get('bus') and seg['bus'].get('buslines'):
            bl = seg['bus']['buslines'][0]
            line = _polyline(bl.get('polyline', '') or '')
            segs.append({'kind': 'bus', 'points': line,
                         'duration_s': _iv(bl.get('duration')),
                         'name': bl.get('name', '公交')})
    out = {'mode': 'transit', 'from': fr, 'to': to, 'segs': segs,
           'duration_s': int(tr.get('duration', 0)), 'distance_m': float(tr.get('distance', 0)),
           '_tz': tz_hours(a['lat'], a['lon'])}
    if segs:
        _put(_ROUTE_FILE, rk, {'segs': [{'kind': s['kind'],
                                         'points': [[p[0], p[1]] for p in s['points']],
                                         'duration_s': s['duration_s'], 'name': s['name']} for s in segs],
                               'duration_s': out['duration_s'],
                               'distance_m': out['distance_m']}, _ROUTE_TTL)
    return out


# ---------- 火车 ----------
# 限流已下沉到 rail._guard()：只有「真要发 12306 请求」时记账，命中路由/经停/票面缓存一律不算。
# 这里保留一个薄封装，方便调试与历史调用方，不重复计数。
def _rail_guard():
    return rail._guard()



_PLAN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.plan-cache.json')
FARE_CACHE_V = 5   # v5：rail.route 对「具体站名」严格过滤后，旧缓存里混着到别的站的车，必须整体作废


def _cache_read():
    try:
        return json.load(open(_PLAN_CACHE_FILE, encoding='utf-8'))
    except Exception:
        return {}


def _cache_write(d):
    try:
        json.dump(d, open(_PLAN_CACHE_FILE, 'w', encoding='utf-8'), ensure_ascii=False)
    except Exception:
        pass


def _clip(rows, to, fr=None):
    """只保留「出发站 → 票面终点」，绝不越界（车次前面经过的站、后面还开去的城市都不算）"""
    if fr:
        for i, s in enumerate(rows):
            if s['station'] == fr:
                rows = rows[i:]
                break
    for i, s in enumerate(rows):
        if s['station'] == to:
            return rows[:i + 1]
    return rows


def _rows_from_plain(plain):
    """把 {station,arrive,depart} 明文时刻还原成带 datetime 的站表"""
    rows = []
    for i, s in enumerate(plain):
        a = datetime.strptime(s['arrive'], '%Y-%m-%d %H:%M')
        d = datetime.strptime(s['depart'], '%Y-%m-%d %H:%M')
        rows.append({'station': s['station'], 'seq': s.get('seq') or str(i + 1),
                     'arrive': a, 'depart': d})
    return rows


_SEAT_NAMES = {'1': '硬座', '2': '软座', '3': '硬卧', '4': '软卧', '6': '高级软卧',
               '9': '商务座', 'P': '特等座', 'M': '一等座', 'O': '二等座', 'S': '商务座'}
_SEAT_CODES = {'硬座': '1', '软座': '2', '硬卧': '3', '软卧': '4', '高级软卧': '6',
               '商务座': '9', '特等座': 'P', '一等座': 'M', '二等座': 'O',
               '无座': '1W'}    # 无座在 12306 余票里是硬座码的第二次出现，_stock 存成 1W


def _seats_of(seat_types):
    """12306 seat_types 字串 → 真实存在的席别名（顺序保留）"""
    out = []
    for ch in str(seat_types or ''):
        nm = _SEAT_NAMES.get(ch)
        if nm and nm not in out:
            out.append(nm)
    return out


def _wz_stock(stock):
    """无座余票：12306 余票串里同一席别码第二次出现，_stock 存成 XXW，硬座/二等座都有可能"""
    return sum(int(v or 0) for k, v in (stock or {}).items() if str(k).endswith('W'))


def _seats_view(seats, stock):
    """可售席别：有座席别按余票过滤；无座单独算（来自任意 *W 余票码）"""
    seats = list(seats or [])
    wz = _wz_stock(stock)
    if wz > 0 and '无座' not in seats:
        seats.append('无座')
    if not stock:
        return seats, list(seats)
    avail = []
    for n in seats:
        if n == '无座':
            if wz > 0:
                avail.append(n)
        elif int(stock.get(_SEAT_CODES.get(n, ''), 0) or 0) > 0:
            avail.append(n)
    return seats, avail


_FARE_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.fare-cache.json')


def _fare_cached(train_no, from_no, to_no, seat_types, date):
    """票价查一次缓存 10 分钟：出票才查，规划不查"""
    presale_guard(date)
    key = f'{train_no}|{from_no}|{to_no}|{date}'
    try:
        d = json.load(open(_FARE_CACHE, encoding='utf-8'))
    except Exception:
        d = {}
    ent = d.get(key)
    if ent and now_ct().timestamp() - float(ent.get('ts') or 0) < 600:
        return ent.get('fares') or {}
    # 限流在 rail.fares() 里按真实请求记，这里不再重复计数
    fares = rail.fares(train_no, from_no, to_no, seat_types, date)
    d[key] = {'ts': now_ct().timestamp(), 'fares': fares}
    try:
        json.dump(d, open(_FARE_CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
    except Exception:
        pass
    return fares


def _fare_via_route(fr, to, date, code):
    presale_guard(date)
    for x in rail.route(fr, to, date):
        if x['code'].upper() == str(code).upper():
            return x, rail.fares(x['train_no'], x.get('from_no') or '', x.get('to_no') or '',
                                 x.get('seat_types') or '', date)
    return None, {}


PRESALE_DAYS = 15      # 12306 现阶段只放 15 天内的票（含今天）


def presale_guard(date):
    """超预售期先说清「还没开售、最近能排到哪天」，别让调用方拿到一句「没有车次」"""
    try:
        d = datetime.strptime(str(date), '%Y-%m-%d').date()
    except Exception:
        return
    today = now_ct().date()
    last = today + timedelta(days=PRESALE_DAYS - 1)
    if d > last:
        raise RuntimeError(f'12306 现在只放 {PRESALE_DAYS} 天内的票，{d:%Y-%m-%d} 还没开售；'
                           f'最近能排到 {last:%Y-%m-%d}，到那天再排远期')
    if d < today:
        raise RuntimeError(f'{d:%Y-%m-%d} 已经过去了，排不了')


def rail_trip(fr, to, date, code=None, after=None, before=None):
    presale_guard(date)
    a_s = after.strftime('%H:%M') if isinstance(after, datetime) else (after or '')
    b_s = before.strftime('%H:%M') if isinstance(before, datetime) else (before or '')
    key = f'{fr}|{to}|{date}|{code or ""}|{a_s}|{b_s}'
    ent = _cache_read().get(key)
    if ent and ent.get('v') == FARE_CACHE_V and now_ct().timestamp() - float(ent.get('ts') or 0) < 600:
        rows = _clip(_rows_from_plain(ent['stops']), ent['to'], ent['from'])
        return {'mode': 'train', 'code': ent['code'], 'train_no': ent.get('train_no') or 'cache',
                'from_no': ent.get('from_no'), 'to_no': ent.get('to_no'),
                'seat_types': ent.get('seat_types'), 'seats': ent.get('seats') or [],
                'seats_all': ent.get('seats_all') or [], 'stock': ent.get('stock') or {},
                'from': ent['from'], 'to': ent['to'], 'stops': rows,
                'depart': rows[0]['depart'], 'arrive': rows[-1]['arrive'], '_cache': True}
    # rail.route / rail.stops / rail.fares 各自在真实请求前限流，这里不再记账
    if code:
        rows = rail.route(fr, to, date)
        cand = [x for x in rows if x['code'] == code.upper()]
        if not cand:
            raise RuntimeError(f'{fr}->{to} {date} 没有车次 {code}')
        x = cand[0]
        dep = datetime.strptime(date, '%Y-%m-%d') + timedelta(hours=int(x['depart'][:2]), minutes=int(x['depart'][3:5]))
        arr = datetime.strptime(date, '%Y-%m-%d') + timedelta(hours=int(x['arrive'][:2]), minutes=int(x['arrive'][3:5]))
        while arr < dep:
            arr += timedelta(days=1)
        leg = {'code': x['code'], 'train_no': x['train_no'], 'from_tele': x['from_tele'],
               'to_tele': x['to_tele'], 'from_no': x.get('from_no'), 'to_no': x.get('to_no'),
               'seat_types': x.get('seat_types'), 'stock': x.get('stock') or {},
               'from': rail.name_of(x['from_tele']),
               'to': rail.name_of(x['to_tele']), 'dep_dt': dep, 'arr_dt': arr}
        date_of_leg = date
    else:
        after_s = after.strftime('%H:%M') if isinstance(after, datetime) else after
        before_s = before.strftime('%H:%M') if isinstance(before, datetime) else before
        rs, kind = rail_plan.plan(fr, to, date,
                                  rail_plan.hm(date, after_s) if after_s else None,
                                  rail_plan.hm(date, before_s) if before_s else None)
        if not rs:
            raise RuntimeError(f'{fr}->{to} {date} 找不到车次')
        leg = rs[0]['legs'][0]
        date_of_leg = leg['dep_dt'].strftime('%Y-%m-%d')
    st = rail.stops(leg['train_no'], leg['from_tele'], leg['to_tele'], date_of_leg)
    # 逐站落绝对时刻（用同一套回绕规则）
    base = leg['dep_dt']
    rows, prev = [], None
    for s in st:
        d = {'station': s['station'], 'seq': s['seq'], 'stopover': s['stopover']}
        for k in ('arrive', 'depart'):
            v = s[k]
            if v and v != '----':
                t = datetime.strptime(date_of_leg, '%Y-%m-%d') + timedelta(
                    hours=int(v[:2]), minutes=int(v[3:5]))
                while prev and t < prev - timedelta(hours=6):
                    t += timedelta(days=1)
                while t < base - timedelta(hours=6):
                    t += timedelta(days=1)
                prev = max(prev, t) if prev else t
                d[k] = t
        if d.get('arrive') and not d.get('depart'):
            d['depart'] = d['arrive']
        if d.get('depart') and not d.get('arrive'):
            d['arrive'] = d['depart']
        rows.append(d)
    rows = _clip(rows, leg['to'], leg['from'])
    stock = leg.get('stock') or {}
    allseats, avail = _seats_view(_seats_of(leg.get('seat_types')), stock)
    trip = {'mode': 'train', 'code': leg['code'], 'train_no': leg['train_no'],
            'from_no': leg.get('from_no'), 'to_no': leg.get('to_no'),
            'seat_types': leg.get('seat_types'), 'seats': avail, 'seats_all': allseats,
            'stock': stock,
            'from': leg['from'], 'to': leg['to'], 'stops': rows,
            'depart': leg['dep_dt'], 'arrive': leg['arr_dt'], '_tz': 8}
    # 票价不在这里查：规划只定车次与席别，出票时再统一取价（少打一次 12306，价格也更新）
    d = _cache_read()
    d[key] = {'ts': now_ct().timestamp(), 'v': FARE_CACHE_V, 'code': trip['code'], 'from': trip['from'], 'to': trip['to'],
              'train_no': trip['train_no'], 'from_no': trip['from_no'], 'to_no': trip['to_no'],
              'seat_types': trip['seat_types'], 'seats': avail, 'seats_all': allseats, 'stock': stock,
              'stops': [{'station': s['station'], 'seq': s['seq'],
                         'arrive': _sta(s['arrive']), 'depart': _sta(s['depart'])} for s in rows],
              'depart': _sta(trip['depart']), 'arrive': _sta(trip['arrive'])}
    _cache_write(d)
    return trip


def _sta(t):
    return t.strftime('%Y-%m-%d %H:%M')


def _lerp(a, b, f):
    return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)


def _dist_km(la1, lo1, la2, lo2):
    r = 6371.0
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _along_polyline(pts, frac):
    """按累计长度取折线上的某一点（frac 0..1）"""
    if not pts:
        return None
    seg = [(pts[0], 0.0)]
    total = 0.0
    for p, q in zip(pts, pts[1:]):
        d = math.hypot(q[0] - p[0], q[1] - p[1])
        total += d
        seg.append((q, total))
    if total == 0:
        return pts[0]
    target = total * min(1, max(0, frac))
    for (p, s0), (q, s1) in zip(seg, seg[1:]):
        if s1 >= target:
            f = (target - s0) / max(1e-12, (s1 - s0))
            return _lerp(p, q, f)
    return pts[-1]


# ---------- 定位 ----------
def position(trip, now):
    if trip.get('legs'):
        return _position_multi(trip, now)
    return _position_single(trip, now)


def _leg_station_point(name):
    """换乘站在哪：按车站名解析坐标，失败就不给坐标（宁可没坐标也不瞎给）"""
    try:
        g = geocode(str(name))
        return round(float(g['lat']), 6), round(float(g['lon']), 6)
    except Exception:
        return None, None


TRANSFER_MIN_SAME = 20      # 同站换乘最短 20 分钟
TRANSFER_MIN_CROSS = 60     # 同城异站最短 60 分钟


def check_transfers(legs):
    for i in range(len(legs) - 1):
        a, b = legs[i], legs[i + 1]
        gap = (b['depart'] - a['arrive']).total_seconds() / 60
        if str(a.get('mode')) in ('drive', 'walk', 'bike', 'transit') or str(b.get('mode')) in ('drive', 'walk', 'bike', 'transit'):
            if gap < 0:
                raise RuntimeError(f'{a["to"]} 还没到，下一段 {b["from"]} 就先开了，排不出来')
            continue
        same = str(a['to']) == str(b['from'])
        need = TRANSFER_MIN_SAME if same else TRANSFER_MIN_CROSS
        if gap < need:
            where = '同站' if same else '同城异站'
            raise RuntimeError(f'{a["to"]} → {b["from"]}（{where}）只有 {int(gap)} 分钟，少于 {need} 分钟，赶不上这个换乘')


def _position_multi(trip, now):
    legs = trip['legs']
    first = legs[0]
    if now < first['depart']:
        pt = _position_single(first, now)
        return pt
    for i, lg in enumerate(legs):
        if now <= lg['arrive']:
            return _position_single(lg, min(now, lg['arrive'] - timedelta(seconds=1)))
        if i + 1 < len(legs):
            nxt = legs[i + 1]
            if now < nxt['depart']:
                lat, lon = _leg_station_point(lg['to'])
                wait = int((nxt['depart'] - now).total_seconds() / 60)
                out = {'state': 'transfer', 'name': f"{lg['to']}（换乘等车，还有 {wait} 分钟）",
                       'segment': [lg['to'], nxt['from']], 'at': _sta(now), 'wait_min': wait}
                if lat is not None:
                    out['lat'], out['lon'] = lat, lon
                return out
    return _position_single(legs[-1], now)


DEST_GRACE_MIN = 15     # 到站后 15 分钟算「刚下车」，还在车站


def _city_of(name):
    """从站名/地名推城市名：广州南 → 广州，成都东 → 成都"""
    s = str(name or '')
    try:
        g = geocode(s)
        c = (g.get('city') or '').strip()
        if c:
            return c.replace('市', '')
    except Exception:
        pass
    for suf in ('站', '机场'):
        if s.endswith(suf):
            s = s[:-len(suf)]
    while len(s) > 2 and s[-1] in '东西南北中':
        s = s[:-1]
    return s


def _dest_state(trip, now, p):
    """到站之后的处理：短时间还在车站，久了只报城市级（不挂在车站坐标上装精确）"""
    if now <= trip['arrive'] + timedelta(minutes=DEST_GRACE_MIN):
        return p
    stay = trip.get('_stay')
    if stay:
        return _position_core(stay, now)
    city = _city_of(trip['to'])
    lat = lon = None
    try:
        g = geocode(city)
        lat, lon = round(float(g['lat']), 5), round(float(g['lon']), 5)
    except Exception:
        pass
    out = {'state': 'in_city', 'name': f'在{city}', 'city': city, 'city_level': True,
           'at': _sta(now), 'note': '到站了，但这趟没给停留点，只说城市级'}
    if lat is not None:
        out['lat'], out['lon'] = lat, lon
    return out


def _position_single(trip, now):
    p = _position_core(trip, now)
    if p.get('state') in ('arrived', 'arrived_sched') and trip.get('arrive'):
        return _dest_state(trip, now, p)
    return p


def _position_core(trip, now):
    real_now, delay_known = now, trip.get('_delay_known', False)
    if delay_known and trip.get('_delay'):
        now = now - trip['_delay']          # 知道晚点时，按「表定时刻 = 实际时刻 - 晚点」推
    if trip['mode'] == 'flight':
        a, b = trip['from_airport'], trip['to_airport']
        if now < trip['depart']:
            return {'state': 'not_started', 'name': a['name'], 'at': _sta(now)}
        if now >= trip['arrive']:
            if not delay_known and real_now > trip['arrive'] + timedelta(minutes=5):
                return {'state': 'arrived_sched', 'name': b['name'], 'at': _sta(real_now),
                        'note': '按航班时刻该落地了，但没有实时航班信息，若晚点可能还在飞'}
            return {'state': 'arrived', 'name': b['name'], 'at': _sta(now)}
        f = (now - trip['depart']).total_seconds() / max(1, trip['duration_s'])
        lat, lon = _gc_point(a, b, f)
        return {'lat': round(lat, 5), 'lon': round(lon, 5),
                'name': f"{a['name']}→{b['name']} 飞行中（{f * 100:.0f}%）",
                'segment': [a['name'], b['name']], 'progress': round(f, 3),
                'at': _sta(now), 'next': b['name'], 'next_arrive': _sta(trip['arrive'])}

    if trip['mode'] == 'train':
        rows = trip['stops']
        # 只算到票面终点为止：Z316 之后还开往汉中，但她的行程到广元就结束了
        for i, s in enumerate(rows):
            if s['station'] == trip['to']:
                rows = rows[:i + 1]
                break
        # 1) 站内停靠：到站未发车时必须钉在站上，不能沿线滑走
        for i, s in enumerate(rows):
            if s['arrive'] < s['depart'] and s['arrive'] <= now <= s['depart']:
                g = geocode(s['station'])
                nxt = rows[i + 1] if i + 1 < len(rows) else None
                return {'lat': round(g['lat'], 6), 'lon': round(g['lon'], 6),
                        'name': f"{s['station']}（停站）", 'station': s['station'],
                        'segment': [s['station'], (nxt['station'] if nxt else s['station'])],
                        'progress': 0.0, 'at': _sta(now),
                        'next_station': nxt['station'] if nxt else '',
                        'next_arrive': _sta(nxt['arrive']) if nxt else '',
                        'addr': g.get('addr', ''), 'train': trip['code']}
        for a, b in zip(rows, rows[1:]):
            if a['depart'] <= now <= b['arrive']:
                span = (b['arrive'] - a['depart']).total_seconds() or 1
                frac = (now - a['depart']).total_seconds() / span
                ga, gb = geocode(a['station']), geocode(b['station'])
                # 沿两站之间的公路走廊走，避免直线穿越无人区
                key = (a['station'], b['station'])
                if key not in _ROUTE:
                    _ROUTE[key] = road_route('drive', a['station'], b['station'])['points']
                pts = _ROUTE[key]
                wgs = _along_polyline(pts, frac)      # (lon, lat)
                if not wgs:
                    wgs = _lerp((ga['lon'], ga['lat']), (gb['lon'], gb['lat']), frac)
                return {'lat': round(wgs[1], 6), 'lon': round(wgs[0], 6),
                        'name': f"{a['station']}→{b['station']} 途中（{frac * 100:.0f}%）",
                        'segment': [a['station'], b['station']],
                        'progress': round(frac, 3),
                        'next_station': b['station'], 'next_arrive': _sta(b['arrive']),
                        'at': _sta(now), 'train': trip['code']}
        if now < rows[0]['depart']:
            return {'state': 'not_started', 'name': trip['from'], 'at': _sta(now)}
        if not delay_known and real_now > rows[-1]['arrive'] + timedelta(minutes=5):
            return {'state': 'arrived_sched', 'name': trip['to'], 'at': _sta(real_now),
                    'plan_arrive': _sta(rows[-1]['arrive']),
                    'note': '按时刻表该到站了，但没有实时正晚点信息；真晚点了就还在路上，我不瞎报位置'}
        return {'state': 'arrived', 'name': trip['to'], 'at': _sta(now)}

    # 公路 / 步行 / 骑行 / 公交
    if trip['mode'] == 'transit':
        start = trip.get('_start') or now_in(trip.get('_tz') or 8)
        elapsed = (now - start).total_seconds()
        acc, pts = 0, []
        for s in trip['segs']:
            if elapsed <= acc + s['duration_s']:
                f = (elapsed - acc) / max(1, s['duration_s'])
                p = _along_polyline(s['points'], f)
                return {'lat': round(p[1], 6), 'lon': round(p[0], 6),
                        'name': f"{trip['from']}→{trip['to']} 途中（{s.get('name', '')}）",
                        'progress': round(f, 3), 'leg': s.get('name', ''),
                        'at': _sta(now), 'sta_name': regeo(p[1], p[0])}
            acc += s['duration_s']
            pts.extend(s['points'])
        p = pts[-1] if pts else (0.0, 0.0)
        return {'lat': round(p[1], 6), 'lon': round(p[0], 6),
                'name': trip['to'], 'progress': 1.0, 'at': _sta(now), 'sta_name': trip['to']}

    start = trip['_start']
    frac = (now - start).total_seconds() / max(1, trip['duration_s'])
    if frac < 0:
        # 刚点出发那一两分钟内开着表，别报「还没出发」又不给坐标
        if (start - now).total_seconds() <= 90:
            frac = 0.0
        else:
            return {'state': 'not_started', 'name': trip['from'], 'at': _sta(now)}
    if frac >= 1:
        return {'state': 'arrived', 'name': trip['to'], 'at': _sta(now)}
    p = _along_polyline(trip['points'], frac)
    return {'lat': round(p[1], 6), 'lon': round(p[0], 6),
            'name': f"{trip['from']}→{trip['to']} 途中（{frac * 100:.0f}%）",
            'progress': round(frac, 3), 'at': _sta(now),
            'sta_name': regeo(p[1], p[0])}


def warm(t):
    """把这一趟要用的坐标/走廊一次取好（落 30/7 天缓存），之后问位置基本不再打高德。
    失败不抛：预热拿不到不该挡住挂行程。"""
    n0 = amap_used_today()
    try:
        if t.get('legs'):
            for lg in t['legs']:
                warm(lg)
            return amap_used_today() - n0
        m = t.get('mode')
        if m == 'train':
            rows = t.get('stops') or []
            i = next((k for k, s in enumerate(rows) if s['station'] == t['from']), 0)
            j = next((k for k, s in enumerate(rows) if s['station'] == t['to']), len(rows) - 1)
            rows = rows[min(i, j):max(i, j) + 1]
            for s in rows:
                geocode(s['station'])
            for a, b in zip(rows, rows[1:]):
                geocode(b['station'])
                road_route('drive', a['station'], b['station'])
        elif m == 'flight':
            geocode((t.get('from_airport') or {}).get('name') or t['from'])
            geocode((t.get('to_airport') or {}).get('name') or t['to'])
        elif m in ('drive', 'walk', 'bike'):
            geocode(t['from']); geocode(t['to'])
        elif m == 'transit':
            geocode(t['from'], t.get('city')); geocode(t['to'], t.get('city'))
    except Exception:
        pass
    return amap_used_today() - n0


def build(mode, fr, to, date=None, code=None, start=None, city=None, after=None, before=None,
          depart=None, arrive=None, stops=None, tz=None, stay=None):
    if mode == 'train':
        if '@' in (fr or '') or '@' in (to or ''):
            raise RuntimeError('12306 只有国内车站；境外铁路没有数据源，别硬算')
        if stops:
            # 已经存过时刻表：直接还原，不打 12306（问位置时用这条）
            rows = _clip(_rows_from_plain(stops), to, fr)
            trip = {'mode': 'train', 'code': code or 'train', 'train_no': 'given',
                    'from': fr, 'to': to, 'stops': rows,
                    'depart': rows[0]['depart'], 'arrive': rows[-1]['arrive'], '_cache': True}
        else:
            trip = rail_trip(fr, to, date, code, after, before)
    elif mode == 'transit':
        trip = transit_route(fr, to, city or fr)
    elif mode in ('drive', 'walk', 'bike'):
        trip = road_route(mode, fr, to, city)
    elif mode in ('flight', 'plane'):
        if not (depart and arrive):
            raise RuntimeError('飞机必须先给起降时刻（depart/arrive），高德不提供航班时刻')
        trip = flight_trip(fr, to, depart, arrive)
    else:
        raise RuntimeError('不认识的出行方式: ' + str(mode))
    # 只在国内活动，时区恒为 +8；tz 参数不再生效（境外早已被挡在门口）
    if stay:
        # 到站后去哪：按「车站 → 停留点」再走一段，没给就只报城市级
        try:
            gp = geocode(to)
            sr = road_route('drive', f"{to}@{gp['lat']},{gp['lon']}", stay)
            sr['_start'] = trip['arrive'] + timedelta(minutes=DEST_GRACE_MIN)
            trip['_stay'] = sr
        except Exception:
            pass
    if start:
        trip['_start'] = datetime.strptime(start, '%Y-%m-%d %H:%M')
    elif mode != 'train':
        trip['_start'] = now_in(trip.get('_tz') or 8)
    if trip.get('duration_s') and trip.get('_start') and not trip.get('arrive'):
        trip['arrive'] = trip['_start'] + timedelta(seconds=trip['duration_s'])
    if trip.get('_start') and not trip.get('depart'):
        trip['depart'] = trip['_start']
    return trip


def build_multi(specs):
    """联程：每段各配一条，段间必须留够换乘时间"""
    trips = []
    prev = None
    for s in (specs or []):
        after = s.get('after')
        if after is None and prev:
            same = str(prev['to']) == str(s.get('from'))
            buf = TRANSFER_MIN_SAME if same else TRANSFER_MIN_CROSS
            after = prev['arrive'] + timedelta(minutes=buf)
        st = s.get('start')
        if after is not None and str(s.get('mode')) not in ('train', 'flight', 'plane', 'transit'):
            st = after.strftime('%Y-%m-%d %H:%M')
        trips.append(build(s.get('mode'), s.get('from'), s.get('to'), s.get('date'), s.get('code'),
                           st, s.get('city'), after, s.get('before'),
                           s.get('depart'), s.get('arrive'), s.get('stops')))
        prev = trips[-1]
    if not trips:
        raise RuntimeError('联程至少要两段')
    if len(trips) == 1:
        # 单段列表按单程处理：中途从当前站排回程时，调用方可能只传一段
        return trips[0]
    check_transfers(trips)
    return {'mode': 'multi', 'legs': trips, 'from': trips[0]['from'], 'to': trips[-1]['to'],
            'depart': trips[0]['depart'], 'arrive': trips[-1]['arrive'], '_tz': 8}


def _summ(t):
    tz = t.get('_tz') or 8
    if t.get('legs'):
        return {'mode': 'multi', 'from': t['from'], 'to': t['to'], 'tz': tz,
                'depart': _sta(t['depart']), 'arrive': _sta(t['arrive']),
                'legs': [_summ(lg) for lg in t['legs']]}
    if t['mode'] == 'train':
        stock = t.get('stock') or {}
        allseats, avail = _seats_view(t.get('seats_all') or t.get('seats') or [], stock)
        return {'mode': 'train', 'code': t['code'], 'from': t['from'], 'to': t['to'],
                'depart': _sta(t['depart']), 'arrive': _sta(t['arrive']), 'tz': tz,
                'train_no': t.get('train_no'), 'from_no': t.get('from_no'), 'to_no': t.get('to_no'),
                'seat_types': t.get('seat_types'), 'seats': avail,
                'seats_all': allseats, 'stock': stock,
                'stops': [{'seq': s['seq'], 'station': s['station'],
                           'arrive': _sta(s['arrive']), 'depart': _sta(s['depart'])} for s in t['stops']]}
    if t['mode'] == 'flight':
        return {'mode': 'flight', 'from': t['from'], 'to': t['to'],
                'depart': _sta(t['depart']), 'arrive': _sta(t['arrive']), 'tz': tz,
                'tz_to': t.get('tz_to'), 'from_airport': t['from_airport'], 'to_airport': t['to_airport']}
    return {'mode': t['mode'], 'from': t['from'], 'to': t['to'], 'tz': tz,
            'distance_km': round(t['distance_m'] / 1000, 1), 'duration_min': t['duration_s'] // 60}


def _bridge(req):
    """给 Aurabot 模块用的 JSON 桥：一次只问一件事，失败就把原因原样回给调用方"""
    # 时刻按「行程所在地」的当地时间算，不读本机时区
    off_min = datetime.now().astimezone().utcoffset().total_seconds() / 60
    op = (req.get('op') or '').strip()
    mode = (req.get('mode') or '').strip()
    fr, to = (req.get('from') or '').strip(), (req.get('to') or '').strip()
    if op not in ('plan', 'where', 'fare', 'warm'):
        raise RuntimeError('op 只能是 plan / where / fare / warm')
    if op == 'fare':
        # 出票时统一取价：优先用规划时存下的 train_no / 序号，少了再按车次回查一次
        tn = str(req.get('train_no') or '')
        if tn and tn != 'cache':
            fares = _fare_cached(tn, str(req.get('from_no') or ''), str(req.get('to_no') or ''),
                                 str(req.get('seat_types') or ''), str(req.get('date') or ''))
        else:
            if not (fr and to and req.get('date') and req.get('code')):
                raise RuntimeError('取价需要 train_no，或 from/to/date/code')
            _, fares = _fare_via_route(fr, to, str(req['date']), req.get('code'))
        if not fares:
            raise RuntimeError('12306 没给这趟的票价，先不出票（不编价）')
        # 12306 不单列无座价：按官方规则「无座与同车最低等座席同价」（硬座/二等座）
        fares = dict(fares or {})
        note = ''
        if '无座' not in fares:
            for alt in ('硬座', '二等座'):
                if alt in fares:
                    fares['无座'] = fares[alt]
                    note = f'无座按 12306 规则与{alt}同价'
                    break
        return {'ok': True, 'fares': fares, 'source': '12306', 'fare_note': note}
    if not req.get('legs') and not (fr and to):
        raise RuntimeError('from / to 都要给')
    if mode in ('flight', 'plane') and not req.get('depart'):
        raise RuntimeError('飞机没配航班数据源（flightKey 留空），也不给起降时刻，不编班次')
    lifts = req.get('legs')
    if lifts:
        t = build_multi(lifts)
    else:
        t = build(mode, fr, to, req.get('date'), req.get('code'), req.get('start'),
                  req.get('city'), req.get('after'), req.get('before'),
                  req.get('depart'), req.get('arrive'), req.get('stops'), req.get('tz'), req.get('stay'))
    tz = t.get('_tz') or 8
    tz_note = '' if off_min == tz * 60 else f'按行程所在地 UTC{tz:+g} 的当地时间算（本机是 UTC{off_min / 60:+.1f}）'
    if op == 'plan':
        out = {'ok': True, 'trip': _summ(t)}
        if t['mode'] != 'train' and t.get('_start'):
            out['trip']['start_at'] = _sta(t['_start'])
        if t.get('_cache'):
            out['cached'] = True
        if tz_note:
            out['tz_note'] = tz_note
        return out
    if op == 'warm':
        # 一次性把这趟要用的坐标/走廊取全，之后问位置就基本不打高德了
        return {'ok': True, 'warm_calls': warm(t), 'used_today': amap_used_today()}
    at = datetime.strptime(req['at'], '%Y-%m-%d %H:%M') if req.get('at') else now_in(tz)
    # 不许问未来：没发生的事不能先给她一个坐标
    if not req.get('allowFuture') and at > now_in(tz) + timedelta(minutes=1):
        raise RuntimeError('问的是将来时间，现在还没发生，只能报此刻或过去的时刻')
    if 'delay' in req:
        t['_delay_known'] = True
        t['_delay'] = timedelta(minutes=int(req.get('delay') or 0))
    p = position(t, at)
    if 'lat' not in p:
        return {'ok': True, 'state': p.get('state', 'unknown'), 'name': p.get('name', ''),
                'at': p.get('at', _sta(at)), 'note': p.get('note', ''),
                'plan_arrive': p.get('plan_arrive', ''), 'trip': _summ(t)['mode']}
    addr = regeo(p['lat'], p['lon'])
    p['addr'] = addr or (str(p.get('name', '')) + ' 附近')
    out = {'ok': True, 'position': p, 'trip': _summ(t)['mode']}
    if t.get('_cache'):
        out['cached'] = True
    if tz_note:
        out['tz_note'] = tz_note
    return out


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'json':
        try:
            rail.start_budget(75)   # 整次排程最多 75s 打 12306（换乘搜索会查多个枢纽站），超了就如实说「太慢」，不干等 150s
            # 按字节读、显式按 UTF-8 解：宿主进程的 stdin 编码不一定是 UTF-8（GBK 会把「成都」变成乱码）
            _raw = sys.stdin.buffer.read()
            try:
                _txt = _raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                _txt = _raw.decode('gbk', errors='replace')
            req = json.loads(_txt or '{}')
            out = _bridge(req)
        except Exception as e:
            req = locals().get('req')
            out = {'ok': False, 'error': str(e)}
            try:
                os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs'), exist_ok=True)
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs', 'last-engine-error.json'), 'w', encoding='utf-8') as f:
                    json.dump({'ts': now_ct().strftime('%Y-%m-%d %H:%M:%S'), 'req': req, 'error': str(e)}, f, ensure_ascii=False, indent=2)
            except Exception:
                pass
        # 输出一律写 UTF-8 字节，绕开控制台编码（宿主读的是 UTF-8）
        sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode('utf-8') + b'\n')
        sys.stdout.buffer.flush()
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == 'used':
        # 看一眼今天到底打了多少次高德、缓存里存了多少条
        print(f'今日高德调用 {amap_used_today()} 次（预算 {AMAP_DAILY_BUDGET}）')
        for label, p in (('地名', _GEO_FILE), ('折线', _ROUTE_FILE), ('地址', _REGEO_FILE)):
            d = _disk_load(p)
            print(f'  {label}缓存 {len(d)} 条  {p}')
        mk = _disk_load(_EXHAUST_FILE)
        if str(mk.get('day')) == datetime.now(CT).strftime('%Y-%m-%d'):
            print(f'  今日已打满的接口：{mk.get("svc")}（{mk.get("info")}）')
        sys.exit(0)
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['plan', 'where'])
    ap.add_argument('mode')
    ap.add_argument('fr'); ap.add_argument('to'); ap.add_argument('date', nargs='?')
    ap.add_argument('at', nargs='?')
    ap.add_argument('--code', default=None)
    ap.add_argument('--after', default=None)
    ap.add_argument('--before', default=None)
    ap.add_argument('--city', default=None)
    a = ap.parse_args()
    if a.cmd == 'plan':
        if a.mode == 'train':
            t = build('train', a.fr, a.to, a.date, code=a.code, after=a.after, before=a.before)
            print(f"{t['code']} {t['from']} {t['depart']:%m-%d %H:%M} -> {t['to']} {t['arrive']:%m-%d %H:%M}")
            for s in t['stops'][:8]:
                print('   ', s['seq'], s['station'], _sta(s['arrive']), _sta(s['depart']))
        else:
            t = build(a.mode, a.fr, a.to, city=a.city)
            extra = f"{t['distance_m'] / 1000:.1f}km / {t['duration_s'] // 60}min"
            print(f"{a.mode} {t['from']} -> {t['to']}  {extra}")
    else:
        t = build(a.mode, a.fr, a.to, a.date, code=a.code, after=a.after,
                  before=a.before, city=a.city)
        p = position(t, datetime.strptime(a.at, '%Y-%m-%d %H:%M'))
        print(json.dumps(p, ensure_ascii=False, indent=2))
        if 'lat' in p:
            print('地址:', regeo(p['lat'], p['lon']))


