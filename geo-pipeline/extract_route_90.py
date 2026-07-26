#!/usr/bin/env python3
"""
Phase 1 - Extract the Highway 90 corridor through Tiberias from OpenStreetMap
and seed it into MongoDB for the on-route engine.

Pipeline: Overpass API -> shapely linemerge -> EPSG:2039 metric buffer -> MongoDB upsert.
Always writes hwy90_tiberias.geojson so you can eyeball the result at geojson.io.

Usage:
    python extract_route_90.py                 # extract + seed local MongoDB
    python extract_route_90.py --dry-run       # extract + GeoJSON only, no Mongo
    python extract_route_90.py --mongo-uri mongodb://host:27017/highway90

pip install requests shapely pyproj pymongo
"""
import argparse
import json
import sys

import requests
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, mapping
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, transform

SLUG = "hwy90-tiberias"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Tiberias corridor bbox (south, west, north, east):
# Hamat Tiberias in the south, up past the northern exit toward Migdal junction.
BBOX = (32.745, 35.490, 32.845, 35.580)

# Union of two sources, both clipped to the bbox:
#   1. ways tagged ref=90 directly
#   2. member ways of the Route 90 road relation — catches city stretches where
#      the segments carry the relation but not their own ref tag (the likely
#      reason the first field extraction came back short at 2.90 km)
OVERPASS_QUERY = f"""
[out:json][timeout:90];
rel["type"="route"]["route"="road"]["ref"="90"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]})->.r90;
(
  way["highway"]["ref"="90"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
  way(r.r90)({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
);
out geom;
"""

# WGS84 <-> Israel TM Grid, so buffers/lengths are in real meters
_to_itm = Transformer.from_crs("EPSG:4326", "EPSG:2039", always_xy=True).transform
_to_wgs = Transformer.from_crs("EPSG:2039", "EPSG:4326", always_xy=True).transform


def fetch_route_ways() -> list:
    # Overpass answers anonymous clients with 406 — identify the app
    # (field-verified fix from the first Tiberias extraction run)
    headers = {"User-Agent": "TiberiasNavPoC/1.0"}
    resp = requests.post(OVERPASS_URL, data={"data": OVERPASS_QUERY}, headers=headers, timeout=90)
    resp.raise_for_status()
    return resp.json().get("elements", [])


def build_centerline(elements: list):
    """Merge OSM way segments into one LineString.

    Route 90 is dual-carriageway in stretches, so OSM often maps two parallel
    one-way ways. linemerge then yields multiple strands; for the PoC we take
    the longest strand as the centerline. Phase 2: keep one line per direction.
    Returns (centerline, ways_fetched, strands_after_merge).
    """
    segments = [
        LineString([(nd["lon"], nd["lat"]) for nd in el["geometry"]])
        for el in elements
        if el.get("type") == "way" and len(el.get("geometry", [])) >= 2
    ]
    if not segments:
        sys.exit("No Route 90 ways found in the Tiberias bbox - check the query.")

    merged = linemerge(MultiLineString(segments))
    if isinstance(merged, LineString):
        return merged, len(segments), 1
    strands = list(merged.geoms)
    longest = max(strands, key=lambda g: transform(_to_itm, g).length)
    return longest, len(segments), len(strands)


def build_geometries(centerline_wgs: LineString, buffer_m: float):
    """Return (centerline GeoJSON, buffer-polygon GeoJSON, length in meters)."""
    line_itm = transform(_to_itm, centerline_wgs)
    # simplify(2.0) trims vertex count at +-2 m cost; orient() forces the CCW
    # exterior ring MongoDB expects for GeoJSON polygons.
    buf_itm = orient(line_itm.buffer(buffer_m).simplify(2.0), sign=1.0)
    return mapping(centerline_wgs), mapping(transform(_to_wgs, buf_itm)), line_itm.length


def seed_mongo(uri: str, doc: dict) -> None:
    from pymongo import MongoClient  # lazy import: --dry-run works without pymongo

    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    db = client.get_default_database("highway90")
    routes = db["routes"]
    routes.create_index([("geometry", "2dsphere")])
    routes.create_index([("buffer", "2dsphere")])  # Phase 2: $geoIntersects checks
    routes.update_one({"slug": doc["slug"]}, {"$set": doc}, upsert=True)
    print(f"Seeded '{doc['slug']}' into {db.name}.routes")


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract Route 90 (Tiberias) from OSM into MongoDB")
    ap.add_argument("--mongo-uri", default="mongodb://localhost:27017/highway90")
    ap.add_argument("--buffer", type=float, default=30.0,
                    help="on-route corridor half-width in meters (default 30)")
    ap.add_argument("--out", default="hwy90_tiberias.geojson")
    ap.add_argument("--dry-run", action="store_true", help="write GeoJSON only, skip MongoDB")
    args = ap.parse_args()

    print("Querying Overpass for highway ref=90 in the Tiberias bbox...")
    elements = fetch_route_ways()
    centerline, n_ways, n_strands = build_centerline(elements)
    geometry, buffer_geo, length_m = build_geometries(centerline, args.buffer)

    print(f"  ways fetched:        {n_ways}")
    note = "  (dual carriageway - using longest strand)" if n_strands > 1 else ""
    print(f"  strands after merge: {n_strands}{note}")
    print(f"  centerline length:   {length_m / 1000:.2f} km, corridor: +-{args.buffer:.0f} m")

    doc = {
        "slug": SLUG,
        "name": "Highway 90 - Tiberias corridor",
        "geometry": geometry,   # GeoJSON LineString  (2dsphere)
        "buffer": buffer_geo,   # GeoJSON Polygon     (2dsphere, Phase 2 $geoIntersects)
        "lengthM": round(length_m, 1),
        "bufferM": args.buffer,
        "source": "OpenStreetMap via Overpass",
    }

    feature_collection = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"role": "centerline", "lengthM": doc["lengthM"]},
             "geometry": geometry},
            {"type": "Feature", "properties": {"role": "buffer", "bufferM": args.buffer},
             "geometry": buffer_geo},
        ],
    }
    with open(args.out, "w") as f:
        json.dump(feature_collection, f)
    print(f"  wrote {args.out} (inspect at geojson.io)")

    if args.dry_run:
        print("Dry run - MongoDB skipped.")
        return
    seed_mongo(args.mongo_uri, doc)


if __name__ == "__main__":
    main()
