"""Natural Earth GeoJSON -> static/world.js (MAP page of the SATELLITES tab): land rings and border lines as flat integer
arrays in 1/10 degree, points closer than STEP dropped.
Usage: python installer/make_world.py DIR static/world.js [STEP]
DIR holds ne_50m_land.geojson and ne_50m_admin_0_boundary_lines_land.geojson from
https://github.com/nvkelso/natural-earth-vector/tree/v5.1.2/geojson"""
import json
import os
import sys

src, out = sys.argv[1], sys.argv[2]
STEP = float(sys.argv[3]) if len(sys.argv) > 3 else 0.2      # degrees; 0.2 was used for static/world.js


def lines_of(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return c
    if t == "MultiPolygon":
        return [ring for poly in c for ring in poly]
    if t == "LineString":
        return [c]
    if t == "MultiLineString":
        return c
    return []


def pack(path, min_pts):
    data = json.load(open(os.path.join(src, path), encoding="utf-8"))
    res = []
    for f in data["features"]:
        for line in lines_of(f["geometry"]):
            pts, last = [], None
            for lon, lat in ((p[0], p[1]) for p in line):
                if last is None or abs(lon - last[0]) >= STEP or abs(lat - last[1]) >= STEP:
                    pts.append((lon, lat))
                    last = (lon, lat)
            if line and pts[-1] != (line[-1][0], line[-1][1]):
                pts.append((line[-1][0], line[-1][1]))
            if len(pts) >= min_pts:
                res.append([v for lon, lat in pts for v in (round(lon * 10), round(lat * 10))])
    return res


land = pack("ne_50m_land.geojson", 4)
borders = pack("ne_50m_admin_0_boundary_lines_land.geojson", 2)
with open(out, "w", encoding="ascii", newline="\n") as f:
    f.write("// World map for the SATELLITES tab, MAP page: Natural Earth 1:50m land and country borders (public domain,\n")
    f.write("// https://www.naturalearthdata.com/), simplified; flat [lon, lat, lon, lat...] in 1/10 degree. Made by make_world.py.\n")
    f.write("const WORLD_LAND = " + json.dumps(land, separators=(",", ":")) + ";\n")
    f.write("const WORLD_BORDERS = " + json.dumps(borders, separators=(",", ":")) + ";\n")
print(len(land), "land rings", sum(len(r) for r in land) // 2, "points;", len(borders), "border lines", sum(len(r) for r in borders) // 2, "points;", os.path.getsize(out), "bytes")
