#!/usr/bin/env python3
"""Compares an xlsx / docx before and after a round trip (ADR-0143) the way bots read them —
with openpyxl and python-docx — and prints what was lost or changed.

  /tmp/of/bin/python tools/office-fidelity/compare.py BEFORE AFTER [--json]

Exit 0: nothing a bot reads changed; 1: losses (listed); 2: usage / unreadable file.
xlsx: sheets and their order, cell values and formulas (formulas compared as text after
normalising case and spaces), number formats, merged ranges, column widths and row heights
(±0.6), frozen panes, conditional formatting ranges and rule types, data validations, defined
names, fonts (bold / italic / size / colour), fills, borders, alignment.
docx: paragraph texts and styles, run bold / italic, list numbering presence, tables (count,
style, cell texts, merged cells), headers and footers per section (default / first page),
section orientation, page size and margins (±0.05 cm), page breaks.
pptx: slide size, layout names, per slide its layout, shapes (type, placeholder type, box ±0.05
cm), texts with levels and bold, tables, charts (type, categories, series values), notes.
"""
import json
import re
import sys
from pathlib import Path


def _norm_formula(v):
    # Case, spaces, the _xlfn. prefix and quotes around sheet names ('Лист'!A1 = Лист!A1) do not
    # change a formula.
    if isinstance(v, str) and v.startswith("="):
        return re.sub(r"'([^'!]+)'!", r"\1!", re.sub(r"\s+", "", v)).upper().replace("_XLFN.", "")
    return v


def _widths(ws):
    """Column widths per letter: a <col min max> range covers every column in it."""
    from openpyxl.utils import get_column_letter

    out = {}
    for d in ws.column_dimensions.values():
        if d.width and d.min and d.max:
            for i in range(d.min, d.max + 1):
                out[get_column_letter(i)] = round(d.width, 1)
    return out


def _ext_rules(path):
    """Conditional formats / validations kept only in the x14 extension (Excel reads them, openpyxl drops them)."""
    import zipfile

    with zipfile.ZipFile(path) as z:
        return {n.rsplit("/", 1)[-1]: (z.read(n).count(b"<x14:conditionalFormatting"), z.read(n).count(b"<x14:dataValidation "))
                for n in z.namelist() if n.startswith("xl/worksheets/sheet")}


def _color(c):
    if c is None:
        return None
    rgb = getattr(c, "rgb", None)
    return rgb[-6:].upper() if isinstance(rgb, str) else None


def xlsx_snapshot(path):
    from openpyxl import load_workbook

    wb = load_workbook(path)  # formulas as text (data_only=False)
    snap = {"sheets": wb.sheetnames, "names": sorted(wb.defined_names.keys()), "sheet": {}, "x14_ext (cf, dv)": _ext_rules(path)}
    for ws in wb.worksheets:
        cells, fmt, style = {}, {}, {}
        for row in ws.iter_rows():
            for c in row:
                if c.value is None and not c.has_style:
                    continue
                k = c.coordinate
                v = c.value
                cells[k] = _norm_formula(v.isoformat() if hasattr(v, "isoformat") else v)
                if c.value is not None:
                    fmt[k] = c.number_format
                f = c.font
                style[k] = {
                    "b": bool(f.b), "i": bool(f.i), "sz": float(f.sz or 0), "col": _color(f.color),
                    "fill": _color(c.fill.fgColor) if c.fill and c.fill.fill_type == "solid" else None,
                    "border": tuple(bool(getattr(c.border, s).style) for s in ("left", "right", "top", "bottom")),
                    "h": c.alignment.horizontal, "wrap": bool(c.alignment.wrap_text),
                }
        cf = sorted((str(rng.sqref), r.type) for rng in ws.conditional_formatting for r in rng.rules)
        dv = sorted((str(d.sqref), d.type, d.formula1) for d in ws.data_validations.dataValidation)
        snap["sheet"][ws.title] = {
            "cells": cells, "fmt": fmt, "style": style,
            "merged": sorted(str(r) for r in ws.merged_cells.ranges),
            "widths": _widths(ws),
            "heights": {k: round(v.height, 1) for k, v in ws.row_dimensions.items() if v.height},
            "freeze": ws.freeze_panes, "cf": cf, "dv": dv,
        }
    return snap


def docx_snapshot(path):
    from docx import Document

    d = Document(path)
    paras = []
    for p in d.paragraphs:
        if not p.text.strip() and len(p._p.xpath(".//w:br[@w:type='page']")) == 0:
            continue
        paras.append({
            "text": p.text, "style": p.style.name if p.style is not None else None,
            "bold": [r.text for r in p.runs if r.bold and r.text.strip()],
            "italic": [r.text for r in p.runs if r.italic and r.text.strip()],
            "num": bool(p._p.xpath("./w:pPr/w:numPr")) or (p.style is not None and "List" in p.style.name),
            "pagebreak": bool(p._p.xpath(".//w:br[@w:type='page']")),
        })
    tables = []
    for t in d.tables:
        tables.append({
            "style": t.style.name if t.style is not None else None,
            "cells": [[c.text for c in r.cells] for r in t.rows],
            "merged": len(t._tbl.xpath(".//w:gridSpan")) + len(t._tbl.xpath(".//w:vMerge")),
            "header": bool(t._tbl.xpath(".//w:trPr/w:tblHeader")),
        })
    secs = []
    for s in d.sections:
        cm = lambda v: round((v or 0) / 360000, 2)  # EMU → cm
        secs.append({
            "orient": int(s.orientation), "w": cm(s.page_width), "h": cm(s.page_height),
            "margins": [cm(s.left_margin), cm(s.right_margin), cm(s.top_margin), cm(s.bottom_margin)],
            "first": bool(s.different_first_page_header_footer),
            "header": s.header.paragraphs[0].text if s.header.paragraphs else "",
            "footer": s.footer.paragraphs[0].text if s.footer.paragraphs else "",
            "first_header": s.first_page_header.paragraphs[0].text if s.first_page_header.paragraphs else "",
        })
    return {"paragraphs": paras, "tables": tables, "sections": secs}


def pptx_snapshot(path):
    from pptx import Presentation
    from pptx.util import Emu

    prs = Presentation(path)
    cm = lambda v: round(Emu(v or 0).cm, 2)
    slides = []
    for sl in prs.slides:
        shapes = []
        for sh in sl.shapes:
            d = {"type": str(sh.shape_type), "name_kind": sh.name.rsplit(" ", 1)[0], "box": [cm(sh.left), cm(sh.top), cm(sh.width), cm(sh.height)]}
            if sh.is_placeholder:
                d["ph"] = str(sh.placeholder_format.type)
            if sh.has_text_frame:
                d["paras"] = [(p.text, p.level, [bool(r.font.bold) for r in p.runs if r.text.strip()]) for p in sh.text_frame.paragraphs if p.text.strip()]
            if getattr(sh, "has_table", False) and sh.has_table:
                d["table"] = [[c.text for c in r.cells] for r in sh.table.rows]
            if getattr(sh, "has_chart", False) and sh.has_chart:
                ch = sh.chart
                d["chart"] = {"type": str(ch.chart_type), "cats": [str(c) for c in ch.plots[0].categories], "series": [(s.name, list(s.values)) for s in ch.plots[0].series]}
            shapes.append(d)
        notes = sl.notes_slide.notes_text_frame.text if sl.has_notes_slide else ""
        slides.append({"layout": sl.slide_layout.name, "shapes": shapes, "notes": notes})
    return {"size": [cm(prs.slide_width), cm(prs.slide_height)], "layouts": [l.name for l in prs.slide_layouts], "slides": slides}


def csv_snapshot(path):
    import csv

    raw = Path(path).read_bytes()
    text = raw.decode("utf-8-sig")
    dialect = csv.Sniffer().sniff(text.splitlines()[0], delimiters=";,\t")
    return {"delimiter": dialect.delimiter, "bom": raw.startswith(b"\xef\xbb\xbf"),
            "rows": [{"cells": r} for r in csv.reader(text.splitlines(keepends=True), dialect)]}


SNAPSHOTS = {".xlsx": xlsx_snapshot, ".xls": xlsx_snapshot, ".docx": docx_snapshot, ".doc": docx_snapshot,
             ".pptx": pptx_snapshot, ".ppt": pptx_snapshot, ".csv": csv_snapshot}


def diff(a, b, path=""):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in b:
                out.append(f"{path}/{k}: lost ({a[k]!r})")
            elif k not in a:
                out.append(f"{path}/{k}: added ({b[k]!r})")
            else:
                out += diff(a[k], b[k], f"{path}/{k}")
    elif isinstance(a, list) and isinstance(b, list) and all(isinstance(x, dict) for x in a + b):
        for i in range(max(len(a), len(b))):
            if i >= len(b):
                out.append(f"{path}[{i}]: lost ({a[i]!r})")
            elif i >= len(a):
                out.append(f"{path}[{i}]: added ({b[i]!r})")
            else:
                out += diff(a[i], b[i], f"{path}[{i}]")
    elif isinstance(a, float) and isinstance(b, float):
        if abs(a - b) > (0.6 if "/widths" in path or "/heights" in path else 0.05):
            out.append(f"{path}: {a!r} → {b!r}")
    elif a != b:
        out.append(f"{path}: {a!r} → {b!r}")
    return out


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    before, after = Path(argv[1]), Path(argv[2])
    # A legacy round trip (xlsx → xls → xlsx, …) compares two OOXML files: the snapshot is the
    # original's format.
    snap = SNAPSHOTS.get(before.suffix.lower())
    if snap is None:
        print(f"unsupported: {before}")
        return 2
    d = diff(snap(before), snap(after))
    if "--json" in argv:
        print(json.dumps({"file": before.name, "changes": d}, ensure_ascii=False, indent=1))
    else:
        print(f"{before.name}: {'no losses' if not d else f'{len(d)} change(s)'}")
        for line in d:
            print("  " + line)
    return 1 if d else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
