"""Excel版 (TOEIC_2.xlsm) の記録を data/records.json に変換する一回用スクリプト。

使い方:  python tools/import_xlsm.py path/to/TOEIC_2.xlsm
openpyxl 不要（xlsm を zip として直接読む）。
"""
import json
import re
import sys
import zipfile
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
OUT = Path(__file__).resolve().parent.parent / "data" / "records.json"


def read_sheets(path):
    z = zipfile.ZipFile(path)
    sst = [
        "".join(t.text or "" for t in si.findall("m:t", NS) + si.findall("m:r/m:t", NS))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)
    ]
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    rid = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    sheets = {}
    for s in wb.find("m:sheets", NS):
        x = ET.fromstring(z.read("xl/" + target[s.get(rid)]))
        cells = {}
        for c in x.iter("{%s}c" % NS["m"]):
            v = c.find("m:v", NS)
            if v is None:
                continue
            val = sst[int(v.text)] if c.get("t") == "s" else v.text
            col, row = re.match(r"([A-Z]+)(\d+)", c.get("r")).groups()
            cells[(col, int(row))] = val
        sheets[s.get("name")] = cells
    return sheets


def excel_date(v):
    return (date(1899, 12, 30) + timedelta(days=int(float(v)))).isoformat()


def serialize(data):
    """app.js の serialize() と同じ形式（配列の要素を1行ずつ）で書き出す。"""
    one = lambda o: json.dumps(o, ensure_ascii=False, separators=(", ", ": "))
    lines = lambda arr, ind: ",\n".join(ind + one(o) for o in arr)
    sess = ",\n".join(
        '  {"id": %s, "items": [\n%s\n  ]}' % (one(s["id"]), lines(s["items"], "    "))
        for s in data["sessions"]
    )
    return (
        "{\n"
        '"settings": {"mode": %s, "parts": [\n%s\n]},\n' % (one(data["settings"]["mode"]), lines(data["settings"]["parts"], "  "))
        + '"activeSession": %s,\n' % one(data["activeSession"])
        + '"done": %s,\n' % ("[\n%s\n]" % lines(data["done"], "  ") if data["done"] else "[]")
        + '"sessions": [\n%s\n]\n}\n' % sess
    )


def main(path):
    sh = read_sheets(path)
    st, log, work = sh["設定"], sh["記録"], sh["作業"]

    parts, r = [], 2
    while st.get(("A", r)):
        parts.append({"name": st[("A", r)], "count": int(float(st[("B", r)]))})
        r += 1
    mode = st.get(("D", 2)) or "全体シャッフル"

    sessions = {}
    last_row = max((row for (col, row) in log if col == "B"), default=1)
    for r in range(2, last_row + 1):
        sid = log.get(("B", r))
        if not sid:
            continue
        result = (log.get(("F", r)) or "").strip()
        item = {
            "seq": int(float(log[("C", r)])),
            "part": log[("D", r)],
            "q": int(float(log[("E", r)])),
            "done": result != "",
        }
        if result and log.get(("A", r)):
            item["date"] = excel_date(log[("A", r)])
        sessions.setdefault(sid, []).append(item)

    data = {
        "settings": {"parts": parts, "mode": mode},
        "activeSession": work.get(("F", 3), ""),
        "sessions": [{"id": k, "items": v} for k, v in sessions.items()],
        "done": [],
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(serialize(data), encoding="utf-8", newline="\n")
    for s in data["sessions"]:
        print(s["id"], sum(i["done"] for i in s["items"]), "/", len(s["items"]))
    print("active:", data["activeSession"], "->", OUT)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\rtkkp\Desktop\TOEIC_2.xlsm")
