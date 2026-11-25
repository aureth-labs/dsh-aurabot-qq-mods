# -*- coding: utf-8 -*-
"""基于 12306 实时班次的行程规划：直达成优先，必要时自动拼 1 次换乘
用法：
  python rail_plan.py 成都东 西安北 2026-11-18 --after 08:00 --before 14:00
  python rail_plan.py 雅安  西安北 2026-11-18 --after 06:30 --json out.json
"""
import sys, os, json, time, argparse
from datetime import datetime, timedelta
_TMP = os.environ.get('TRAVEL_TMP') or os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _TMP)
import rail

CACHE = os.environ.get('RAIL_PLAN_CACHE') or os.path.join(_TMP, 'rail-cache.json')
TTL = 3600
HUBS = ['成都东', '重庆北', '西安北', '郑州东', '武汉', '长沙南', '北京西', '上海虹桥',
        '广州南', '兰州西', '贵阳北', '昆明南', '南昌西', '南京南', '济南西', '太原南',
        '石家庄', '合肥南', '杭州东', '沈阳北', '南宁东', '福州']

_cache = {}
if os.path.exists(CACHE):
    try:
        _cache = json.load(open(CACHE, encoding='utf-8'))
    except Exception:
        _cache = {}


def _save():
    try:
        json.dump(_cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
    except Exception:
        pass


def rte(fr, to, d):
    # v2：rail.route 现在会对「具体站名」严格过滤，旧缓存里混着到其他站的车，必须换代
    k = f'v2|{fr}|{to}|{d}'
    hit = _cache.get(k)
    if hit and time.time() - hit['ts'] < TTL:
        return hit['rows']
    rows = rail.route(fr, to, d)
    _cache[k] = {'ts': time.time(), 'rows': rows}
    _save()
    return rows


def hm(date, s, day=0):
    """把 'HH:MM' 落到某天的 datetime"""
    return datetime.strptime(date, '%Y-%m-%d') + timedelta(
        days=day, hours=int(s[:2]), minutes=int(s[3:5]))


def to_leg(x, date):
    """把一行班次变成带绝对时刻的 leg（跨日按回绕修正）"""
    dep, arr = hm(date, x['depart']), hm(date, x['arrive'])
    while arr < dep:
        arr += timedelta(days=1)
    return {'code': x['code'], 'train_no': x['train_no'],
            'from_tele': x['from_tele'], 'to_tele': x['to_tele'],
            'from_no': x.get('from_no', ''), 'to_no': x.get('to_no', ''),
            'seat_types': x.get('seat_types', ''), 'stock': x.get('stock') or {},
            'from': rail.name_of(x['from_tele']), 'to': rail.name_of(x['to_tele']),
            'depart_hm': x['depart'], 'arrive_hm': x['arrive'], 'duration': x['duration'],
            'dep_dt': dep, 'arr_dt': arr}


def block_of(x, date):
    """相对日期的一天窗口里，同一车次可能次日再开，这里按需生成 day+1 版本"""
    base = to_leg(x, date)
    nxt = dict(base)
    nxt['dep_dt'] = base['dep_dt'] + timedelta(days=1)
    nxt['arr_dt'] = base['arr_dt'] + timedelta(days=1)
    return [base, nxt]


def pick_direct(fr, to, date, after=None, before=None):
    out = []
    for x in rte(fr, to, date):
        for leg in block_of(x, date):
            if after and leg['dep_dt'] < after:
                continue
            if before and leg['arr_dt'] > before:
                continue
            out.append({'legs': [leg], 'dep': leg['dep_dt'], 'arr': leg['arr_dt'],
                        'duration': leg['arr_dt'] - leg['dep_dt'], 'transfers': 0})
    return out


def pick_transfer(fr, to, date, after=None, before=None, hubs=None, deadline=None):
    """换乘搜索要查很多枢纽站，必须有截止时间：到点就用已有的候选，不能无限打 12306"""
    res = []
    for h in (hubs or HUBS):
        if deadline and time.time() > deadline:
            break
        if h in (fr, to):
            continue
        a, b = rte(fr, h, date), rte(h, to, date)
        if not a or not b:
            continue
        for x1 in a:
            for l1 in block_of(x1, date):
                if after and l1['dep_dt'] < after:
                    continue
                for x2 in b:
                    for l2 in block_of(x2, date):
                        gap = l2['dep_dt'] - l1['arr_dt']
                        same = l1['to_tele'] == l2['from_tele']
                        need = timedelta(minutes=25) if same else timedelta(minutes=75)
                        if gap < need or gap > timedelta(hours=12):
                            continue
                        if before and l2['arr_dt'] > before:
                            continue
                        res.append({'legs': [l1, l2], 'dep': l1['dep_dt'], 'arr': l2['arr_dt'],
                                    'duration': l2['arr_dt'] - l1['dep_dt'], 'transfers': 1,
                                    'gap': gap, 'station_change': not same})
    res.sort(key=lambda z: (z['arr'], z['duration']))
    return res[:5]


def plan(fr, to, date, after=None, before=None, max_show=3):
    direct = pick_direct(fr, to, date, after, before)
    direct.sort(key=lambda z: (z['dep'], z['arr']))
    if direct:
        return direct[:max_show], 'direct'
    # 直达没有才搜换乘：最多给它 30s，到点就用手上已有的候选
    trans = pick_transfer(fr, to, date, after, before, deadline=time.time() + 30)
    return trans, 'transfer' if trans else 'none'


def show(r):
    for leg in r['legs']:
        print(f"    {leg['code']:<7} {leg['from']:<6} {leg['dep_dt']:%m-%d %H:%M} -> "
              f"{leg['to']:<6} {leg['arr_dt']:%m-%d %H:%M}  ({leg['duration']})")
    if r['transfers']:
        extra = '（需跨站换乘）' if r.get('station_change') else '（同站换乘）'
        print(f"    换乘等待 {str(r['gap'])[:-3]} {extra}   全程 {str(r['duration'])[:-3]}")


def export(r):
    legs = []
    for leg in r['legs']:
        d = {k: v for k, v in leg.items() if k not in ('dep_dt', 'arr_dt')}
        d['depart_at'] = leg['dep_dt'].strftime('%Y-%m-%d %H:%M')
        d['arrive_at'] = leg['arr_dt'].strftime('%Y-%m-%d %H:%M')
        d['stops'] = rail.stops(leg['train_no'], leg['from_tele'], leg['to_tele'],
                                leg['dep_dt'].strftime('%Y-%m-%d'))
        legs.append(d)
    return {'depart': r['dep'].strftime('%Y-%m-%d %H:%M'),
            'arrive': r['arr'].strftime('%Y-%m-%d %H:%M'),
            'total': str(r['duration'])[:-3],
            'transfers': r['transfers'],
            'station_change': bool(r.get('station_change')),
            'legs': legs}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('fr'); ap.add_argument('to'); ap.add_argument('date')
    ap.add_argument('--after', default=None); ap.add_argument('--before', default=None)
    ap.add_argument('--json', default=None)
    a = ap.parse_args()
    after = hm(a.date, a.after) if a.after else None
    before = hm(a.date, a.before) if a.before else None
    rs, kind = plan(a.fr, a.to, a.date, after, before)
    print(f"{a.fr} -> {a.to} {a.date}  方案类型: {kind}  条数 {len(rs)}")
    for i, r in enumerate(rs, 1):
        print(f"  方案{i}: {r['dep']:%m-%d %H:%M} 出发 -> {r['arr']:%m-%d %H:%M} 到达 "
              f"({r['transfers']}次换乘)")
        show(r)
    if a.json and rs:
        json.dump(export(rs[0]), open(a.json, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=2)
        print('json ->', a.json)
