"""家人代办执行器（通用版）：读 xlsx/docx 做统计。
由 family-tasks 模块用 bundled Python 调用，所有路径通过参数传入。
不在本文件里写死任何机器路径。
"""
import sys, io, json, os
from collections import Counter

def load_rows(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = []
    for r in range(1, ws.max_row + 1):
        seq = ws.cell(r, 2).value
        name = ws.cell(r, 6).value
        amt = ws.cell(r, 11).value
        seller = ws.cell(r, 14).value
        if not isinstance(amt, (int, float)):
            continue
        if amt > 5_000_000:  # 合计行
            continue
        rows.append({"seq": seq, "name": str(name or ""), "amt": amt,
                     "seller": str(seller or "").strip()})
    wb.close()
    return rows

def try_handle(text, table_path):
    """返回 (结果文字, 是否办成)。table_path 由调用方传入。"""
    import re
    t = text
    rows = None

    def need_rows():
        nonlocal rows
        if rows is None:
            if not table_path or not os.path.exists(table_path):
                return False
            try:
                rows = load_rows(table_path)
            except Exception:
                return False
        return bool(rows)

    if re.search(r"最贵|最值钱", t):
        if not need_rows(): return None, False
        top = max(rows, key=lambda x: x["amt"])
        return f"最贵的是序号{top['seq']}「{top['name']}」，{top['amt']:,.2f} 元", True
    if re.search(r"最便宜|最不值钱|最低价", t):
        if not need_rows(): return None, False
        low = min(rows, key=lambda x: x["amt"])
        return f"最便宜的是序号{low['seq']}「{low['name']}」，{low['amt']:,.2f} 元", True
    if re.search(r"多少台|几台|总共.*设备|设备.*总数", t):
        if not need_rows(): return None, False
        return f"表里一共 {len(rows)} 台设备", True
    if re.search(r"合计|总额|总价|加起来", t):
        if not need_rows(): return None, False
        return f"合计 {sum(x['amt'] for x in rows):,.2f} 元", True
    if re.search(r"平均", t):
        if not need_rows(): return None, False
        s = sum(x["amt"] for x in rows)
        return f"平均每台 {s/len(rows):,.2f} 元（共 {len(rows)} 台，合计 {s:,.2f}）", True
    if re.search(r"中位数", t):
        if not need_rows(): return None, False
        v = sorted(x["amt"] for x in rows)
        n = len(v)
        m = v[n//2] if n % 2 else (v[n//2-1] + v[n//2]) / 2
        return f"中位数 {m:,.2f} 元", True
    if re.search(r"哪家公司|哪个公司|买得最多", t):
        if not need_rows(): return None, False
        c = Counter(x["seller"] for x in rows if x["seller"] and x["seller"] != "/")
        if not c: return None, False
        name, n = c.most_common(1)[0]
        return f"买得最多的是{name}，{n} 台", True
    return None, False

if __name__ == "__main__":
    # argv: <text> <table_path>
    text = sys.argv[1] if len(sys.argv) > 1 else ""
    table = sys.argv[2] if len(sys.argv) > 2 else ""
    result, ok = try_handle(text, table)
    print(json.dumps({"ok": bool(ok), "result": result or ""}, ensure_ascii=False))
