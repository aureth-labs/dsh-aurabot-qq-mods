# -*- coding: utf-8 -*-
"""12306 行程取数：车次列表 + 全经停站时刻
用法：
  python rail.py route 成都东 重庆北 2026-11-18
  python rail.py stops D3058 2026-11-18
"""
import sys
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')  # 任何入口下都别让中文变成乱码
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
import os, json, time, random, unicodedata, urllib3, requests
urllib3.disable_warnings()

# 引擎工作目录：默认脚本所在目录，可用 TRAVEL_TMP 覆盖（方便搬到别的机器）
_TMP = os.environ.get('TRAVEL_TMP') or os.path.dirname(os.path.abspath(__file__))

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
BASE = 'https://kyfw.12306.cn/otn'

_s = requests.Session()
_s.headers.update({'User-Agent': UA})
_stations = {}
_last_call = [0.0]

# —— 限流与超时：只在「真要打 12306」时记账，缓存命中一律不算 ——
_LIMIT_FILE = os.environ.get('RAIL_LIMIT_FILE') or os.path.join(_TMP, '.rail-calls.json')
LIMIT_N = 30            # 10 分钟内最多 30 次真实请求
LIMIT_WIN = 600
NET_TIMEOUT = 12        # 单次请求 25s 太长：12306 正常 1–2s，12s 足够，卡住就早点认
TRIES = 2               # 4 次重试会叠成 100s+，留给主排程的预算撑不住
_BUDGET = [0.0]         # 本次进程的总预算截止时刻（0 = 不限）


def start_budget(sec=40):
    """给整次排程一个总预算：超了就不再死磕，直接认「这次没回话」，别让主人干等 2 分钟"""
    _BUDGET[0] = time.time() + float(sec)



def _guard():
    now = time.time()
    try:
        ts = json.load(open(_LIMIT_FILE, encoding='utf-8'))
        ts = [t for t in ts if isinstance(t, (int, float))]
    except Exception:
        ts = []
    ts = [t for t in ts if now - t < LIMIT_WIN]
    if len(ts) >= LIMIT_N:
        raise RuntimeError(f'12306 查询太密了（{LIMIT_WIN // 60} 分钟内 {LIMIT_N} 次打满），先保护性停手几分钟。'
                           f'已记下的行程和票不受影响，过几分钟再重排；不是坏了。')
    ts.append(now)
    try:
        json.dump(ts, open(_LIMIT_FILE, 'w', encoding='utf-8'))
    except Exception:
        pass

MIN_INTERVAL = 0.9          # 两次请求最短间隔，避免被限流
STATION_CACHE = os.environ.get('RAIL_STATIONS') or os.path.join(_TMP, '.stations.json')


def _load_station_cache():
    """车站表落盘：12306 的 station_name.js 抓不到时照样能排，不会整表变空"""
    global _stations
    if _stations:
        return True
    try:
        if os.path.exists(STATION_CACHE):
            _stations = json.load(open(STATION_CACHE, encoding='utf-8'))
            return bool(_stations)
    except Exception:
        pass
    return False


def _init():
    global _stations
    # 静态请求头不依赖网络，先设好；车站表有缓存就直接用，不发任何请求
    _s.headers.update({'Referer': BASE + '/leftTicket/init',
                       'X-Requested-With': 'XMLHttpRequest',
                       'Accept': '*/*'})
    if _stations:
        return
    if _load_station_cache():
        return
    try:
        r = _s.get(BASE + '/resources/js/framework/station_name.js', timeout=20, verify=False)
        r.encoding = 'utf-8'
        raw = r.text.split("='", 1)[-1].split("';", 1)[0].strip('@')
        for it in raw.split('@'):
            f = it.split('|')
            if len(f) >= 3:
                _stations[f[1]] = f[2]
    except Exception:
        _stations = {}
    if len(_stations) >= 100:
        try:
            json.dump(_stations, open(STATION_CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
        except Exception:
            pass
    else:
        _stations = {}
        if not _load_station_cache():
            raise RuntimeError('12306 车站表没取到（可能被限流或网络不通），这次先不排车次，过几分钟再试')
    _s.get(BASE + '/leftTicket/init', timeout=20, verify=False)
    _s.headers.update({'Referer': BASE + '/leftTicket/init',
                       'X-Requested-With': 'XMLHttpRequest',
                       'Accept': '*/*'})


def _get(path, params, tries=TRIES):
    """带节流与退避重试的 GET；被限流时重建会话，最后仍失败就给人话"""
    last = None
    for i in range(max(1, tries)):
        if _BUDGET[0] and time.time() > _BUDGET[0]:
            raise RuntimeError('12306 这次太慢了（排程预算用完），先不排了；过两三分钟再试一次')
        gap = MIN_INTERVAL + random.uniform(0, 0.4) - (time.time() - _last_call[0])
        if gap > 0:
            time.sleep(gap)
        try:
            r = _s.get(BASE + path, params=params, timeout=NET_TIMEOUT, verify=False)
            _last_call[0] = time.time()
            r.encoding = 'utf-8'
            j = _json(r)
            return j
        except Exception as e:
            last = e
            time.sleep(1.5 * (i + 1))
            try:
                _s.cookies.clear()
                _s.get(BASE + '/leftTicket/init', timeout=NET_TIMEOUT, verify=False)
                _last_call[0] = time.time()
            except Exception:
                pass
    raise RuntimeError('12306 这次没回话（超时或被挡），先别连着重试；过两三分钟再排一次就行')




def _demojibake(s):
    """站名被编码来回倒过手（UTF-8 字节被当 GBK/Latin-1 读）时还原成中文。
    「鎴愰兘」= UTF-8 的「成都」按 GBK 解出来的样子，反着编回去就能还原。"""
    t = str(s or '')
    if not t:
        return t
    # 先按 Unicode 归一，消掉全角/兼容字符
    try:
        t = unicodedata.normalize('NFKC', t)
    except Exception:
        pass
    # 含替换符或明显乱码区（CJK 兼容/拉丁扩展里的高频乱码）才尝试还原
    for enc_from, enc_to in (('gbk', 'utf-8'), ('latin-1', 'utf-8'), ('cp936', 'utf-8')):
        try:
            fixed = t.encode(enc_from).decode(enc_to)
        except Exception:
            continue
        # 还原结果必须像中国地名：全中文、无替换符，且能在车站表/常见城市里对上一部分
        if _looks_chinese(fixed) and fixed != t:
            return fixed
    return t


def _looks_chinese(s):
    if not s or '\ufffd' in s:
        return False
    return all('\u4e00' <= ch <= '\u9fff' or ch in '·' for ch in s)


def _clean_text(s):
    """去掉零宽/控制/格式字符与所有空白：输入法、聊天转发、模型输出都可能夹带 U+200B、U+FEFF、NBSP 之类。
    肉眼看着是「成都」，比对车站表却对不上——这种「看不见的字符」是「成都都不认识」的常见真凶。"""
    t = str(s or '')
    t = ''.join(ch for ch in t if not ch.isspace() and unicodedata.category(ch)[0] not in ('C', 'Z'))
    try:
        t = unicodedata.normalize('NFKC', t)
    except Exception:
        pass
    return t


def telecode(name):
    _init()
    raw = str(name or '').strip()
    raw = _demojibake(raw)

    # 「乐山站 / 乐山市 / 成都东站 / 乐山 高铁站」这类口语写法先归一
    nm = _clean_text(raw)
    for tail in ('火车站', '高铁站', '车站', '动车站', '站'):
        if nm.endswith(tail) and len(nm) > len(tail):
            nm = nm[: -len(tail)]
            break
    for tail in ('市', '县', '区'):
        if nm.endswith(tail) and len(nm) > len(tail):
            nm = nm[: -len(tail)]
            break
    if nm in _stations:
        return _stations[nm]
    # 名字里混了英文/标点（「成都(city)」「成都 East」）：只留汉字再试一次
    cjk = ''.join(ch for ch in nm if '\u4e00' <= ch <= '\u9fff')
    if cjk and cjk != nm and cjk in _stations:
        return _stations[cjk]
    # 城市名不带站后缀时，优先「XX」「XX东」「XX北」「XX南」「XX西」
    for suf in ('', '东', '北', '南', '西'):
        if (nm + suf) in _stations:
            return _stations[nm + suf]
    # 景区/地名带尾巴（乐山大佛、都江堰景区）：取以它开头的最短车站名，通常是主站
    cands = [k for k in _stations if len(k) >= 2 and nm.startswith(k)]
    if cands:
        order = {'东': 0, '': 1, '北': 2, '南': 3, '西': 4}
        cands.sort(key=lambda k: (len(k), order.get(k[-1], 5), k))
        return _stations[cands[0]]
    # 兜底：名字里含车站名的（人民公园站→? 不猜），只提示最像的，不硬套
    like = [k for k in _stations if len(k) >= 2 and k in nm]
    tip = ('；最像的是 ' + '、'.join(sorted(like, key=len)[:3])) if like else ''
    # 落一份现场：下次再「成都都不认识」，看 repr 就知道是不是夹了看不见的字符
    try:
        os.makedirs(os.path.join(_TMP, 'logs'), exist_ok=True)
        with open(os.path.join(_TMP, 'logs', 'last-unknown-station.json'), 'w', encoding='utf-8') as f:
            json.dump({'raw_repr': repr(raw), 'nm_repr': repr(nm), 'len': len(nm),
                       'stations': len(_stations), 'ts': time.strftime('%Y-%m-%d %H:%M:%S')},
                      f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    raise KeyError('未知车站: ' + raw + tip)


def _json(r):
    """12306 有时返回带 BOM 的 JSON 或 HTML 错误页，统一处理"""
    txt = r.content.decode('utf-8-sig', 'ignore')
    try:
        return json.loads(txt)
    except Exception:
        raise RuntimeError('12306 返回非 JSON（可能超预售期或限流）: '
                           + txt.replace('\n', ' ')[:160])


def _stock(ypinfo):
    """yp_info_new 按「席别1位 + 票价5位 + 余票4位」切块，返回各席别首个余票数"""
    out = {}
    s = str(ypinfo or '')
    i = 0
    while i + 10 <= len(s):
        code, cnt = s[i], s[i + 6:i + 10]
        if cnt.isdigit():
            if code in out:
                # 同一席别码第二次出现 = 无座票（12306 就是这么排的），记成 1W 之类别覆盖座位票
                out[code + 'W'] = int(cnt)
            else:
                out[code] = int(cnt)
        i += 10
    return out


_ROUTE_CACHE = os.path.join(_TMP, '.rail-route-cache.json')
_STOPS_CACHE = os.path.join(_TMP, '.stops-cache.json')


def _disk_read(path):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return {}


def _disk_hit(path, key, ttl):
    d = _disk_read(path)
    e = d.get(key)
    if e and isinstance(e, dict) and time.time() - float(e.get('ts') or 0) < ttl:
        return e.get('v')
    return None


def _disk_put(path, key, v):
    d = _disk_read(path)
    # 只留最近 400 条，别把文件养肥
    if len(d) > 400:
        keep = sorted(d.items(), key=lambda kv: float((kv[1] or {}).get('ts') or 0), reverse=True)[:200]
        d = dict(keep)
    d[key] = {'ts': time.time(), 'v': v}
    try:
        json.dump(d, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    except Exception:
        pass


def _is_specific_station(name):
    """「成都东 / 重庆北 / 上海虹桥」这类带方位的具体站名，要严格按站过滤；
    「成都 / 重庆」这种城市名保持 12306 的城市聚合（会同时给出东站/北站的车）。"""
    s = str(name or '').strip()
    return bool(s) and s != '站' and s[-1] in '东西南北'


def route(from_st, to_st, date, use_cache=True):
    """返回该日该区间所有车次（按出发时间排序）；5 分钟内重复问直接走磁盘缓存，不打 12306"""
    _init()
    fs, ts = telecode(from_st), telecode(to_st)
    key = f'{fs}|{ts}|{date}'
    if use_cache:
        hit = _disk_hit(_ROUTE_CACHE, key, 300)
        if hit is not None:
            return hit
    p = {'leftTicketDTO.train_date': date,
         'leftTicketDTO.from_station': fs,
         'leftTicketDTO.to_station': ts,
         'purpose_codes': 'ADULT'}
    _guard()
    j = _get('/leftTicket/queryZ', p)

    rows = (j.get('data') or {}).get('result') or []
    out = []
    for row in rows:
        f = row.split('|')
        if len(f) < 11:
            continue
        out.append({'train_no': f[2], 'code': f[3],
                    'start_station': f[4], 'end_station': f[5],
                    'from_tele': f[6], 'to_tele': f[7],
                    'depart': f[8], 'arrive': f[9], 'duration': f[10],
                    'from_no': f[16] if len(f) > 16 else '', 'to_no': f[17] if len(f) > 17 else '',
                    'seat_types': f[35] if len(f) > 35 else '',
                    'stock': _stock(f[39]) if len(f) > 39 else {},
                    'from_tele_2': f[6], 'to_tele_2': f[7]})
    out.sort(key=lambda x: x['depart'])
    # 12306 对「成都东→重庆北」会把终到重庆西/重庆的车也返回（按城市聚合）。
    # 明确给了具体站名时，必须只留真正到/发这个站的车，否则会把「到重庆西」当成「到重庆北」。
    if _is_specific_station(from_st):
        out = [x for x in out if x['from_tele'] == fs]
    if _is_specific_station(to_st):
        out = [x for x in out if x['to_tele'] == ts]
    if out:
        _disk_put(_ROUTE_CACHE, key, out)
    return out


SEAT_NAME = {'1': '硬座', '2': '软座', '3': '硬卧', '4': '软卧',
             '6': '高级软卧', '9': '商务座', 'P': '特等座',
             'M': '一等座', 'O': '二等座', 'S': '商务座', 'W': '无座'}


def fares(train_no, from_no, to_no, seat_types, date):
    """该区间真实票价（12306 queryTicketPrice），返回 {席别: 元}"""
    _init()
    p = {'train_no': train_no, 'from_station_no': from_no, 'to_station_no': to_no,
         'seat_types': seat_types, 'train_date': date}
    _guard()
    j = _get('/leftTicket/queryTicketPrice', p)
    data = j.get('data') or {}
    out = {}
    for k, v in data.items():
        if not isinstance(v, str) or '¥' not in v:
            continue
        code = k[1:] if k.startswith('A') and len(k) == 2 else k
        name = SEAT_NAME.get(code)
        if not name:
            continue
        try:
            out[name] = float(v.replace('¥', '').replace(',', '').strip())
        except Exception:
            pass
    return out


def stops(train_no, from_tele, to_tele, date):
    """该车次全部经停站及到/发时刻；同一趟同一天 6 小时内复用"""
    _init()
    key = f'{train_no}|{from_tele}|{to_tele}|{date}'
    hit = _disk_hit(_STOPS_CACHE, key, 6 * 3600)
    if hit is not None:
        return hit
    p = {'train_no': train_no, 'from_station_telecode': from_tele,
         'to_station_telecode': to_tele, 'depart_date': date}
    _guard()
    j = _get('/czxx/queryByTrainNo', p)
    rows = ((j.get('data') or {}).get('data')) or []
    out = []
    for x in rows:
        out.append({'seq': x.get('station_no'), 'station': x.get('station_name'),
                    'arrive': x.get('arrive_time'), 'depart': x.get('start_time'),
                    'stopover': x.get('stopover_time'),
                    'train': x.get('station_train_code')})
    if out:
        _disk_put(_STOPS_CACHE, key, out)
    return out


def name_of(code):
    _init()
    for k, v in _stations.items():
        if v == code:
            return k
    return code


from datetime import datetime, timedelta


def itinerary(from_st, to_st, date, prefer=None, code=None):
    """给一段真实行程：选定车次 + 全经停站（带绝对日期时间）"""
    rs = route(from_st, to_st, date)
    if not rs:
        raise RuntimeError(f'{from_st}->{to_st} {date} 无车次')
    if code:
        cands = [x for x in rs if x['code'] == code]
        if not cands:
            raise RuntimeError(f'{code} 在 {from_st}->{to_st} {date} 不存在')
    elif prefer:
        cands = [x for x in rs if x['depart'] >= prefer] or rs[-1:]
    else:
        cands = rs[:5]

    pick, st = None, None
    for c in cands[:6]:                      # 选一个经停站确实包含目的站的车次
        rows = stops(c['train_no'], c['from_tele'], c['to_tele'], date)
        names = [r['station'] for r in rows]
        if to_st in names or any(names):
            pick, st = c, rows
            if to_st in names:
                break
    base = datetime.strptime(date, '%Y-%m-%d')
    day, prev = 0, None
    rows = []
    for s in st:
        for key in ('arrive', 'depart'):
            v = s[key]
            if v and v != '----':
                hm = datetime.strptime(v, '%H:%M')
                t = base + timedelta(days=day, hours=hm.hour, minutes=hm.minute)
                if prev and t < prev - timedelta(hours=12):
                    day += 1
                    t = base + timedelta(days=day, hours=hm.hour, minutes=hm.minute)
                prev = max(prev, t) if prev else t
                s[key + '_dt'] = t.strftime('%Y-%m-%d %H:%M')
        s['day_offset'] = day
        rows.append(s)
    return {'from': from_st, 'to': to_st, 'date': date,
            'train': pick['code'], 'train_no': pick['train_no'],
            'depart': pick['depart'], 'arrive': pick['arrive'],
            'duration': pick['duration'], 'stops': rows}


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'route'
    if mode == 'route':
        fr, to, d = sys.argv[2], sys.argv[3], sys.argv[4]
        rs = route(fr, to, d)
        print(f'{fr} -> {to}  {d}  共 {len(rs)} 趟')
        for x in rs[:12]:
            print(f"  {x['code']:>6} {name_of(x['from_tele'])} {x['depart']} -> "
                  f"{name_of(x['to_tele'])} {x['arrive']}  ({x['duration']})  train_no={x['train_no']}")
    else:
        code, d = sys.argv[2], sys.argv[3]
        fr = sys.argv[4] if len(sys.argv) > 4 else '成都东'
        to = sys.argv[5] if len(sys.argv) > 5 else '重庆北'
        rs = route(fr, to, d)
        hit = [x for x in rs if x['code'] == code]
        x = hit[0] if hit else None
        if x:
            st = stops(x['train_no'], x['from_tele'], x['to_tele'], d)
            print(f"{code} {name_of(x['from_tele'])}->{name_of(x['to_tele'])} 经停 {len(st)} 站")
            for s in st:
                print(f"  {s['seq']:>2} {s['station']:<10} 到 {s['arrive']:>5} 发 {s['depart']:>5} 停 {s['stopover']}")
