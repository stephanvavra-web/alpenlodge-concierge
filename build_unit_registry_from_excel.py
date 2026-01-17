#!/usr/bin/env python3
"""Build ALPENLODGE unit_registry.json from an Excel mapping.

Expected columns (case/whitespace tolerant):
- Unit id
- Gastname (öffentlich)
- Kategorie
- m²
- max. Personen
- HTML-Datei
- Smoobu Unterkunfts-ID

Usage:
  python3 build_unit_registry_from_excel.py Abgeglichen_mit_SmoobuID.xlsx data/unit_registry.json

Notes:
- Output is purely technical (no marketing text).
- Keeps only stable fields: unit_id, smoobu_id, name, category, max_guests, area_sqm, html_file, active
"""

import json
import sys
from pathlib import Path

import pandas as pd


def norm_col(c: str) -> str:
    return " ".join(str(c).strip().split())


def to_int_or_none(x):
    if x is None or (isinstance(x, float) and pd.isna(x)):
        return None
    s = str(x).strip()
    if not s:
        return None
    # allow "99" or "99.0"
    try:
        i = int(float(s))
        return i
    except Exception:
        return None


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: build_unit_registry_from_excel.py <input.xlsx> <output.json>", file=sys.stderr)
        return 2

    in_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    if not in_path.exists():
        print(f"Input not found: {in_path}", file=sys.stderr)
        return 2

    xl = pd.ExcelFile(in_path)
    # Prefer sheet named 'Blatt 1' if present, else first sheet
    sheet = "Blatt 1" if "Blatt 1" in xl.sheet_names else xl.sheet_names[0]
    df = pd.read_excel(in_path, sheet_name=sheet)

    # normalize column names
    df.columns = [norm_col(c) for c in df.columns]

    required = {
        "Unit id",
        "Gastname (öffentlich)",
        "Kategorie",
        "m²",
        "max. Personen",
        "HTML-Datei",
        "Smoobu Unterkunfts-ID",
    }
    missing = sorted(required - set(df.columns))
    if missing:
        print("Missing required columns:", ", ".join(missing), file=sys.stderr)
        print("Found columns:", ", ".join(df.columns), file=sys.stderr)
        return 2

    out = []
    for _, r in df.iterrows():
        unit_id = to_int_or_none(r.get("Unit id"))
        if unit_id is None:
            continue

        smoobu_id = to_int_or_none(r.get("Smoobu Unterkunfts-ID"))
        name = str(r.get("Gastname (öffentlich)") or "").strip()
        category = str(r.get("Kategorie") or "").strip().lower()
        area_sqm = to_int_or_none(r.get("m²"))
        max_guests = to_int_or_none(r.get("max. Personen"))
        html_file = str(r.get("HTML-Datei") or "").strip()

        if not smoobu_id:
            # keep record but mark inactive? no: we keep active true but allow None if needed
            pass

        out.append(
            {
                "unit_id": unit_id,
                "smoobu_id": smoobu_id,
                "name": name,
                "category": category,
                "max_guests": max_guests,
                "area_sqm": area_sqm,
                "html_file": html_file,
                "active": True,
            }
        )

    # sort stable
    out.sort(key=lambda x: (x["unit_id"] is None, x["unit_id"]))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(out)} units to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
