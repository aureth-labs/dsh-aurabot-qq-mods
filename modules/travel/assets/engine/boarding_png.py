# -*- coding: utf-8 -*-
"""登机牌：横版双折，左侧主牌 + 右侧存根。关键信息可选打码。
stdin 读 JSON，stdout 输出 PNG 绝对路径。"""
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

from PIL import Image, ImageDraw, ImageFont


def _read_json():
    """按字节读、显式 UTF-8（失败再 GBK）：宿主 stdin 编码不一定是 UTF-8"""
    raw = sys.stdin.buffer.read() if hasattr(sys.stdin, 'buffer') else sys.stdin.read().encode('utf-8')
    try:
        return json.loads(raw.decode('utf-8-sig') or '{}')
    except UnicodeDecodeError:
        return json.loads(raw.decode('gbk', errors='replace') or '{}')

FONT = r'C:\Windows\Fonts\msyh.ttc'
FONT_B = r'C:\Windows\Fonts\msyhbd.ttc'


def f(size, bold=False):
    path = FONT_B if (bold and os.path.exists(FONT_B)) else FONT
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def mask_mid(s, head=1, tail=2):
    s = str(s or '')
    if len(s) <= head:
        return (s[:head] if s else '') + '*' * max(1, len(s))
    if len(s) <= head + tail:
        return s[:head] + '*' * max(1, len(s) - head)
    return s[:head] + '*' * (len(s) - head - tail) + s[-tail:]


def vtext(d, x, y, text, font, fill):
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        y += font.size + 2


def band(d, x, y, w, h, seed, masked):
    """条码：一排竖线，打码就整体糊成灰块"""
    if masked:
        d.rectangle([x, y, x + w, y + h], fill=(226, 222, 216), outline=(206, 200, 192))
        d.text((x + 14, y + h / 2 - 9), '已打码', font=f(15, True), fill=(118, 114, 108))
        return
    v = seed or 1
    pos = x
    while pos < x + w - 2:
        v = (v * 1103515245 + 12345) % (2 ** 31)
        wd = 2 + (v % 3)
        if (v >> 8) % 2:
            d.rectangle([pos, y, pos + wd, y + h], fill=(40, 40, 42))
        pos += wd + 2


def main():
    req = _read_json()
    out = req.get('out') or os.path.join(os.path.dirname(__file__), 'boarding.png')
    masked = req.get('mask', True) is not False
    W, H = 1000, 420
    ink = (34, 34, 38)
    grey = (136, 132, 128)
    accent = (22, 74, 128)

    img = Image.new('RGB', (W, H), (252, 251, 249))
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 36], fill=accent)
    d.text((26, 8), 'B O A R D I N G   P A S S   登 机 牌', font=f(17, True), fill=(255, 255, 255))
    d.text((W - 24 - d.textlength('纪念票', font=f(15)), 10), '纪念票', font=f(15), fill=(222, 234, 246))

    d.text((26, 56), str(req.get('code') or '—'), font=f(34, True), fill=accent)
    d.text((26 + d.textlength(str(req.get('code') or '—'), font=f(34, True)) + 16, 66),
           str(req.get('date') or ''), font=f(18), fill=grey)

    # 起降机场
    d.text((26, 112), req.get('from', ''), font=f(38, True), fill=ink)
    ax = 26 + d.textlength(req.get('from', ''), font=f(38, True)) + 18
    d.text((ax, 124), '→', font=f(30, True), fill=accent)
    d.text((ax + 44, 112), req.get('to', ''), font=f(38, True), fill=ink)

    d.text((26, 168), str(req.get('depart') or '—'), font=f(30, True), fill=ink)
    d.text((26, 206), '起飞', font=f(14), fill=grey)
    d.text((190, 168), str(req.get('arrive') or '—'), font=f(30, True), fill=ink)
    d.text((190, 206), '到达', font=f(14), fill=grey)

    _name_raw = req.get('name') or '乘客'
    name_v = mask_mid(_name_raw, 1, 0) if masked else _name_raw
    seq_v = mask_mid(req.get('no') or '', 2, 2) if masked else str(req.get('no') or '—')
    gate_v = (req.get('gate') or '—')
    gate_v = (gate_v[:1] + '*') if masked and len(gate_v) > 1 else gate_v
    cols = [
        (26, [('乘客', name_v), ('舱位', str(req.get('seat_class') or '—'))]),
        (208, [('座位', str(req.get('seat') or '—')), ('序号', seq_v)]),
        (392, [('登机口', gate_v), ('航班', str(req.get('code') or '—'))]),
    ]
    for cx, items in cols:
        yy = 246
        for k, v in items:
            d.text((cx, yy), k, font=f(13), fill=grey)
            d.text((cx, yy + 22), str(v), font=f(21, True), fill=ink)
            yy += 58

    d.text((24, 392), '纪念票 · 不具乘机效力 · 仅作留念', font=f(12), fill=(198, 193, 186))

    stub_x = 660
    x = 0
    while x < H:
        d.line([stub_x, x, stub_x, min(x + 9, H)], fill=(188, 182, 174), width=2)
        x += 18

    vtext(d, stub_x + 22, 54, _name_raw[:2], f(23, True), ink)
    vtext(d, stub_x + 56, 54, '登机牌存根', f(16), grey)

    band(d, stub_x + 108, 96, 190, 58, sum(ord(c) for c in str(req.get('no') or 'x')), masked)
    d.text((stub_x + 108, 168), f"座位 {req.get('seat') or '—'} · {req.get('seat_class') or '—'}", font=f(15), fill=grey)
    d.text((stub_x + 108, 196), str(req.get('code') or ''), font=f(17, True), fill=accent)
    d.text((stub_x + 108, 226), f"{req.get('from', '')} → {req.get('to', '')}", font=f(15), fill=ink)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out, 'PNG')
    print(os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
