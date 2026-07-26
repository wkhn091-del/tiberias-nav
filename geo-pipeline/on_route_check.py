"""
Phase 1 PoC — is a GPS fix "on-route" for Highway 90 through Tiberias?

Core idea: perpendicular distance from the point to the route LineString,
measured in METERS. WGS84 degrees are NOT meters, so both geometries are
reprojected to the Israel TM Grid (EPSG:2039) before measuring.

The anchor coordinates below are ILLUSTRATIVE (hand-placed along the
corridor from Hamat Tiberias north to the Migdal exit). In the real
pipeline the LineString comes from the OSM extract (highway ref=90,
clipped to the Tiberias bbox) and is loaded from MongoDB — never hardcode.

pip install shapely pyproj
"""
from shapely.geometry import Point, LineString
from shapely.ops import transform
from pyproj import Transformer

# (lon, lat) — GeoJSON axis order, south -> north through Tiberias
ROUTE_90_TIBERIAS_WGS84 = LineString([
    (35.5470, 32.7660),  # Hamat Tiberias — southern city limit, on Road 90
    (35.5455, 32.7780),  # southern waterfront
    (35.5420, 32.7900),  # central Tiberias
    (35.5350, 32.8020),  # northern neighborhoods
    (35.5250, 32.8150),  # exit toward Migdal junction — northern limit
])

ON_ROUTE_THRESHOLD_M = 30.0  # GPS noise (5-15 m) + road width margin

# WGS84 -> Israel TM Grid (meters). always_xy keeps (lon, lat) order.
_to_itm = Transformer.from_crs("EPSG:4326", "EPSG:2039", always_xy=True).transform
_route_m = transform(_to_itm, ROUTE_90_TIBERIAS_WGS84)


def check_on_route(lon: float, lat: float) -> dict:
    point_m = Point(*_to_itm(lon, lat))
    dist = point_m.distance(_route_m)          # meters, to nearest segment
    progress_m = _route_m.project(point_m)     # linear reference along route
    return {
        "on_route": dist <= ON_ROUTE_THRESHOLD_M,
        "distance_m": round(dist, 1),
        "progress_m": round(progress_m, 1),    # Phase 2: segment traffic / ETA
        "progress_pct": round(100 * progress_m / _route_m.length, 1),
    }


if __name__ == "__main__":
    print("route length:", round(_route_m.length / 1000, 2), "km")
    print("on the corridor :", check_on_route(35.5420, 32.7900))
    print("out in the lake :", check_on_route(35.5700, 32.7900))
