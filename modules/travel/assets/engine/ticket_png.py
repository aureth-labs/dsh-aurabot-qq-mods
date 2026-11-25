# -*- coding: utf-8 -*-
"""行程票面：版式照真实票根（主票 + 票根），关键信息可选打码。
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
    """按字节读、显式 UTF-8（失败再 GBK）：宿主进程的 stdin 编码不一定是 UTF-8，
    否则「成都东」进来就变成乱码，画出来的票面全是花字，甚至直接崩。"""
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


def qr_on(i, j, seed):
    return ((i * 37 + j * 61 + seed * 13) % 100) < 48


def main():
    req = _read_json()
    out = req.get('out') or os.path.join(os.path.dirname(__file__), 'ticket.png')
    masked = req.get('mask', True) is not False
    W, H = 900, 440
    ink = (38, 36, 34)
    grey = (132, 128, 122)
    accent = (178, 34, 39)

    img = Image.new('RGB', (W, H), (250, 248, 244))
    d = ImageDraw.Draw(img)

    d.rectangle([0, 0, W, 34], fill=accent)
    d.text((24, 7), '行 程 票', font=f(19, True), fill=(255, 255, 255))
    d.text((W - 24 - d.textlength('纪念票', font=f(16)), 9), '纪念票', font=f(16), fill=(255, 228, 228))

    d.text((24, 58), req.get('from', ''), font=f(42, True), fill=ink)
    ax = 24 + d.textlength(req.get('from', ''), font=f(42, True)) + 16
    d.text((ax, 70), '→', font=f(32, True), fill=accent)
    d.text((ax + 44, 58), req.get('to', ''), font=f(42, True), fill=ink)

    d.text((24, 118), str(req.get('code') or '—'), font=f(28, True), fill=accent)
    d.text((118, 126), str(req.get('date') or ''), font=f(18), fill=grey)

    d.rounded_rectangle([24, 168, 360, 250], radius=6, fill=(244, 240, 234), outline=(224, 218, 210))
    d.text((42, 180), str(req.get('depart') or '—'), font=f(32, True), fill=ink)
    d.text((42, 220), '发车', font=f(14), fill=grey)
    d.text((206, 180), str(req.get('arrive') or '—'), font=f(32, True), fill=ink)
    d.text((206, 220), '到达', font=f(14), fill=grey)
    d.line([190, 178, 190, 240], fill=(224, 218, 210), width=1)

    rows = [
        ('席别', str(req.get('seat_class') or '—')),
        ('车厢座位', f"{req.get('coach') or ''} {req.get('seat') or ''}".strip()),
        ('票价', ('¥%.2f' % float(req['price'])) if req.get('price') not in (None, '', '—') else '¥—'),
    ]
    y = 268
    for k, v in rows:
        d.text((26, y + 4), k, font=f(15), fill=grey)
        d.text((112, y), v, font=f(23, True), fill=ink)
        y += 38

    name = req.get('name') or '乘客'
    no = str(req.get('no') or '')
    d.text((26, 388), f"乘车人 {mask_mid(name, 1, 0) if masked else name}", font=f(14), fill=grey)
    d.text((160, 388), f"票号 {mask_mid(no, 2, 2) if masked else no}", font=f(14), fill=grey)
    d.text((24, 412), '纪念票 · 不具乘车效力 · 仅作留念', font=f(12), fill=(198, 193, 186))

    stub_x = 636
    x = 0
    while x < H:
        d.line([stub_x, x, stub_x, min(x + 9, H)], fill=(186, 180, 172), width=2)
        x += 18

    vtext(d, stub_x + 24, 50, name[:2], f(24, True), ink)
    vtext(d, stub_x + 60, 50, '票根存根', f(17), grey)

    qx, qy, qs = stub_x + 108, 92, 120
    d.rectangle([qx, qy, qx + qs, qy + qs], fill=(252, 250, 248), outline=(224, 218, 210))
    seed = sum(ord(c) for c in (no or 'x'))
    for i in range(10):
        for j in range(10):
            if qr_on(i, j, seed):
                px, py = qx + 6 + i * 12, qy + 6 + j * 12
                tone = 150 if masked else 34
                d.rectangle([px, py, px + 11, py + 11], fill=(tone, tone, max(0, tone - 4)))
    if masked:
        d.rectangle([qx + 18, qy + 44, qx + qs - 18, qy + 76], fill=(236, 232, 226))
        d.text((qx + 30, qy + 48), '已 打 码', font=f(19, True), fill=(112, 108, 102))
    d.text((qx + 6, qy + qs + 8), '二维码已打码' if masked else '扫码检票', font=f(13), fill=grey)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out, 'PNG')
    print(os.path.abspath(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
