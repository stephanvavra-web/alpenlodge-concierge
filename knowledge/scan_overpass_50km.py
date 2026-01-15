#!/usr/bin/env python3
"""
ALPENLODGE 50km OSM/Overpass Scanner
- Reads alpenlodge_50km_scan_config.json
- Queries Overpass API for POIs within radius
- Emits alpenlodge_verified_50km_osm_dump.json in the STRICT template schema:
    items[] with lat/lon, url (http/https), source (http/https), last_verified_at (YYYY-MM-DD)
Rules:
- No invention: everything comes from OSM
- Links must be http(s)
- INTERNAL:* never used as url

Usage:
  python3 scan_overpass_50km.py /path/to/alpenlodge_50km_scan_config.json
"""

from __future__ import annotations
import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

def haversine_km(lat1, lon1, lat2, lon2):
    R=6371.0
    phi1=math.radians(lat1); phi2=math.radians(lat2)
    dphi=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
    a=math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dl/2)**2
    return 2*R*math.atan2(math.sqrt(a), math.sqrt(1-a))

def fetch_overpass(query: str) -> Dict[str, Any]:
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_err=None
    for ep in OVERPASS_ENDPOINTS:
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent":"ALPENLODGE-50km-Scanner/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last_err=e
    raise RuntimeError(f"Overpass fetch failed: {last_err}")

def build_query(center_lat: float, center_lon: float, radius_m: int, k: str, values: List[str]) -> str:
    # Search both nodes and ways/relations; output center for ways/relations
    # Example: node(around:50000,lat,lon)[amenity=restaurant];
    parts=[]
    for v in values:
        parts.append(f"node(around:{radius_m},{center_lat},{center_lon})[{k}={v}];")
        parts.append(f"way(around:{radius_m},{center_lat},{center_lon})[{k}={v}];")
        parts.append(f"relation(around:{radius_m},{center_lat},{center_lon})[{k}={v}];")
    q = "[out:json][timeout:60];(" + "".join(parts) + ");out center tags;"
    return q

def osm_url(el: Dict[str, Any]) -> str:
    t = el.get("type")
    i = el.get("id")
    if t == "node":
        return f"https://www.openstreetmap.org/node/{i}"
    if t == "way":
        return f"https://www.openstreetmap.org/way/{i}"
    if t == "relation":
        return f"https://www.openstreetmap.org/relation/{i}"
    return "https://www.openstreetmap.org/"

def name_from_tags(tags: Dict[str, Any]) -> Optional[str]:
    return tags.get("name") or tags.get("brand") or tags.get("operator")

def pick_location_name(tags: Dict[str, Any]) -> Optional[str]:
    return tags.get("addr:city") or tags.get("addr:place") or tags.get("addr:suburb")

def element_lat_lon(el: Dict[str, Any]) -> Optional[Tuple[float,float]]:
    if el.get("type") == "node" and "lat" in el and "lon" in el:
        return float(el["lat"]), float(el["lon"])
    c = el.get("center")
    if isinstance(c, dict) and "lat" in c and "lon" in c:
        return float(c["lat"]), float(c["lon"])
    return None

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("config", help="Path to alpenlodge_50km_scan_config.json")
    ap.add_argument("--max-per-category", type=int, default=2000, help="Safety cap per category query")
    args = ap.parse_args()

    cfg = json.loads(open(args.config, "r", encoding="utf-8").read())
    center = cfg["center"]
    clat = float(center["lat"]); clon = float(center["lon"])
    radius_km = float(cfg["meta"]["rules"]["radius_km"])
    radius_m = int(radius_km * 1000)

    today = date.today().isoformat()

    # Start from strict template
    out = {
        "meta": {
            "version": cfg["meta"]["version"].replace("scan-config", "osm-dump"),
            "language": "de",
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "maintainer": cfg["meta"].get("maintainer", "ALPENLODGE-Team"),
            "rules": cfg["meta"]["rules"],
            "notes": cfg["meta"]["notes"] + ["Datenquelle: OpenStreetMap via Overpass API."]
        },
        "alpenlodge": {
            "name": "ALPENLODGE",
            "timezone": cfg["meta"]["timezone"],
            "center": {"lat": clat, "lon": clon},
            "amenities": []
        },
        "sources": {
            "osm": {"label":"OpenStreetMap (Overpass API)", "url":"https://www.openstreetmap.org", "scope":"general"},
            "overpass": {"label":"Overpass API", "url":"https://overpass-api.de/", "scope":"general"}
        },
        "items": []
    }

    seen=set()

    for cat in cfg["osm_categories"]:
        k = cat["type"]
        values = cat["values"]
        q = build_query(clat, clon, radius_m, k, values)
        data = fetch_overpass(q)
        elements = data.get("elements", [])
        # safety cap
        if len(elements) > args.max_per_category:
            elements = elements[:args.max_per_category]

        for el in elements:
            ll = element_lat_lon(el)
            if not ll:
                continue
            lat, lon = ll
            dist = haversine_km(clat, clon, lat, lon)
            if dist > radius_km:
                continue

            oid = f"osm_{el.get('type')}_{el.get('id')}"
            if oid in seen:
                continue
            seen.add(oid)

            tags = el.get("tags") or {}
            nm = name_from_tags(tags)
            if not nm:
                continue  # unnamed POIs are rarely useful for guests

            loc = pick_location_name(tags) or tags.get("addr:city") or ""

            # Primary url: prefer official website tag if http(s), else OSM object url
            website = tags.get("website") or tags.get("contact:website")
            primary_url = website if (isinstance(website, str) and website.lower().startswith(("http://","https://"))) else osm_url(el)

            src_url = osm_url(el)  # verifiable object page as source

            item = {
                "id": oid,
                "type": k,  # keep raw OSM key as type; you can map later
                "name": nm,
                "location_name": loc,
                "lat": lat,
                "lon": lon,
                "summary": "Quelle: OpenStreetMap (Details siehe Link).",
                "url": primary_url,
                "source": src_url,
                "status": "active",
                "tags": ["within_50km", k],
                "approx_km_road": None,
                "address": None,
                "phone": tags.get("phone") or tags.get("contact:phone") or None,
                "opening_hours_note": "Öffnungszeiten siehe Website/OSM (Stand " + today + ").",
                "last_verified_at": today
            }
            out["items"].append(item)

    out_path = "alpenlodge_verified_50km_osm_dump.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(out_path)
    print(f"Items: {len(out['items'])}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
