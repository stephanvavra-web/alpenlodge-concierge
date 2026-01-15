#!/usr/bin/env python3
"""
Validate Alpenlodge 50km knowledge JSON files.

Checks:
- Required top-level keys
- items[] required fields
- lat/lon ranges (WGS84)
- url + source URLs must be http(s) only (no INTERNAL:* as URL)
- INTERNAL:* allowed only as non-link marker in 'source'
- last_verified_at must be YYYY-MM-DD
- duplicate IDs
- basic type checks

Usage:
  python3 validate_50km_json.py path/to/file.json
Exit code:
  0 ok
  1 validation errors
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from typing import Any, Dict, List

HTTP_RE = re.compile(r"^https?://", re.IGNORECASE)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INTERNAL_PREFIX = "INTERNAL:"

TOP_LEVEL_REQUIRED = ["meta", "alpenlodge", "sources", "items"]

ITEM_REQUIRED = [
    "id", "type", "name", "location_name", "lat", "lon",
    "summary", "url", "source", "status", "tags",
    "approx_km_road", "address", "phone", "opening_hours_note", "last_verified_at"
]

def err(errors: List[str], path: str, msg: str) -> None:
    errors.append(f"{path}: {msg}")

def is_http_url(v: Any) -> bool:
    return isinstance(v, str) and bool(HTTP_RE.match(v.strip()))

def is_internal_marker(v: Any) -> bool:
    return isinstance(v, str) and v.startswith(INTERNAL_PREFIX)

def check_date(errors: List[str], path: str, v: Any) -> None:
    if not isinstance(v, str) or not DATE_RE.match(v):
        err(errors, path, "last_verified_at muss im Format YYYY-MM-DD sein")
        return
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except Exception:
        err(errors, path, "last_verified_at ist kein valides Datum")

def check_lat_lon(errors: List[str], path_lat: str, path_lon: str, lat: Any, lon: Any) -> None:
    if not isinstance(lat, (int, float)):
        err(errors, path_lat, "lat muss Zahl (float) sein")
    else:
        if lat < -90 or lat > 90:
            err(errors, path_lat, "lat außerhalb [-90, 90]")
    if not isinstance(lon, (int, float)):
        err(errors, path_lon, "lon muss Zahl (float) sein")
    else:
        if lon < -180 or lon > 180:
            err(errors, path_lon, "lon außerhalb [-180, 180]")

def check_sources(errors: List[str], data: Dict[str, Any]) -> None:
    sources = data.get("sources")
    if not isinstance(sources, dict):
        err(errors, "sources", "muss ein Objekt sein")
        return
    for k, v in sources.items():
        if not isinstance(v, dict):
            err(errors, f"sources.{k}", "muss ein Objekt sein")
            continue
        url = v.get("url")
        if url is None:
            err(errors, f"sources.{k}.url", "fehlt")
        else:
            if is_internal_marker(url):
                err(errors, f"sources.{k}.url", "INTERNAL:* darf niemals als URL verwendet werden")
            elif not is_http_url(url):
                err(errors, f"sources.{k}.url", "muss http(s) URL sein")

def check_amenities(errors: List[str], data: Dict[str, Any]) -> None:
    amenities = data.get("alpenlodge", {}).get("amenities")
    if amenities is None:
        return
    if not isinstance(amenities, list):
        err(errors, "alpenlodge.amenities", "muss Array sein")
        return
    for i, a in enumerate(amenities):
        p = f"alpenlodge.amenities[{i}]"
        if not isinstance(a, dict):
            err(errors, p, "muss Objekt sein")
            continue
        if "source" in a:
            src = a["source"]
            if not (is_internal_marker(src) or is_http_url(src)):
                err(errors, f"{p}.source", "muss INTERNAL:* oder http(s) URL sein")
        if "last_verified_at" in a:
            check_date(errors, f"{p}.last_verified_at", a["last_verified_at"])

def check_items(errors: List[str], data: Dict[str, Any]) -> None:
    items = data.get("items")
    if not isinstance(items, list):
        err(errors, "items", "muss Array sein")
        return

    seen_ids = set()
    for i, item in enumerate(items):
        p = f"items[{i}]"
        if not isinstance(item, dict):
            err(errors, p, "muss Objekt sein")
            continue

        for field in ITEM_REQUIRED:
            if field not in item:
                err(errors, f"{p}.{field}", "fehlt")

        _id = item.get("id")
        if isinstance(_id, str):
            if _id in seen_ids:
                err(errors, f"{p}.id", f"Doppelte id '{_id}'")
            seen_ids.add(_id)
        else:
            if _id is not None:
                err(errors, f"{p}.id", "muss String sein")

        if "lat" in item and "lon" in item:
            check_lat_lon(errors, f"{p}.lat", f"{p}.lon", item.get("lat"), item.get("lon"))

        url = item.get("url")
        if url is not None:
            if is_internal_marker(url):
                err(errors, f"{p}.url", "INTERNAL:* darf niemals als URL verwendet werden")
            elif not is_http_url(url):
                err(errors, f"{p}.url", "muss http(s) URL sein")

        src = item.get("source")
        if src is not None:
            if not isinstance(src, str):
                err(errors, f"{p}.source", "muss String sein")
            else:
                parts = [s.strip() for s in src.split("|")]
                for part in parts:
                    if not part:
                        continue
                    if is_internal_marker(part):
                        continue
                    if not is_http_url(part):
                        err(errors, f"{p}.source", f"Teil '{part}' ist keine http(s) URL oder INTERNAL:*")

        if "last_verified_at" in item:
            check_date(errors, f"{p}.last_verified_at", item.get("last_verified_at"))

        ak = item.get("approx_km_road")
        if ak is not None and not isinstance(ak, (int, float)):
            err(errors, f"{p}.approx_km_road", "muss Zahl oder null sein")

        tags = item.get("tags")
        if tags is not None and not isinstance(tags, list):
            err(errors, f"{p}.tags", "muss Array sein")

def validate(data: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    for k in TOP_LEVEL_REQUIRED:
        if k not in data:
            err(errors, k, "fehlt")

    check_sources(errors, data)
    check_amenities(errors, data)
    check_items(errors, data)

    meta = data.get("meta", {})
    rules = meta.get("rules", {})
    if isinstance(rules, dict):
        if rules.get("links_only_http_https") is not True:
            err(errors, "meta.rules.links_only_http_https", "sollte true sein")
        if rules.get("never_invent") is not True:
            err(errors, "meta.rules.never_invent", "sollte true sein")

    return errors

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("json_file", help="Path to alpenlodge_verified_50km_*.json")
    args = ap.parse_args()

    try:
        with open(args.json_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"ERROR: Datei kann nicht gelesen werden: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, dict):
        print("ERROR: Top-Level muss JSON-Objekt sein", file=sys.stderr)
        return 1

    errors = validate(data)
    if errors:
        print("VALIDATION FAILED:")
        for e in errors:
            print(" - " + e)
        return 1

    print("OK: Datei ist valide.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
