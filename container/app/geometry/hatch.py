"""Fill engraving as horizontal scan lines. This is how fill engraving moves on the RDC6445S
(test/golden/20mm_fill.rd): alternating-direction lines at a fixed spacing."""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Optional

from shapely.geometry import LineString, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from . import Pt
from .areas import area_of, even_odd, polygons_of
from .order import GRID_ABOVE, nearest_neighbour


def _even_odd(polys: list[list[Pt]]) -> BaseGeometry:
    """XOR within one shape, so the holes in letters like 'O' and 'A' stay empty."""
    return even_odd([area_of(pts) for pts in polys if len(pts) >= 4])


def region(polys: list[list[Pt]], groups: Optional[list[Optional[int]]] = None) -> BaseGeometry:
    """Even-odd inside each group, then union across groups."""
    if groups is None:
        return _even_odd(polys)
    by_group: dict[Optional[int], list[list[Pt]]] = defaultdict(list)
    for pts, g in zip(polys, groups):
        by_group[g].append(pts)
    return unary_union([_even_odd(v) for v in by_group.values()])


def _rows(poly: Polygon, y_first: float, spacing_mm: float) -> list[list[Pt]]:
    """One connected area's scan lines, boustrophedon. Rows sit on the job-wide row grid starting at
    `y_first`, so neighbouring areas line up exactly as when the whole bed was hatched at once."""
    x0, y0, x1, y1 = poly.bounds
    k = max(0, math.ceil((y0 - y_first) / spacing_mm))
    y = y_first + k * spacing_mm
    lines: list[list[Pt]] = []
    row = 0
    while y < y1:
        cut = poly.intersection(LineString([(x0 - 1, y), (x1 + 1, y)]))
        if isinstance(cut, LineString):
            segs = [cut]
        else:  # MultiLineString or GeometryCollection (may include touching points)
            segs = [g for g in getattr(cut, "geoms", []) if isinstance(g, LineString)]
        segs = sorted((s for s in segs if not s.is_empty and s.length > 0.01), key=lambda s: s.bounds[0])
        if segs:
            if row % 2:  # boustrophedon: alternate direction each row to cut travel time
                segs = [LineString(list(s.coords)[::-1]) for s in reversed(segs)]
            else:
                segs = [s if s.coords[0][0] <= s.coords[-1][0] else LineString(list(s.coords)[::-1]) for s in segs]
            lines += [[(float(x), float(yy)) for x, yy in s.coords] for s in segs]
            row += 1
        y += spacing_mm
    return lines


def _variants(lines: list[list[Pt]]) -> list[list[list[Pt]]]:
    """The same scan lines run four ways: from the top row starting left or right, or from the bottom row."""
    mirrored = [ln[::-1] for ln in lines]
    return [lines, mirrored, mirrored[::-1], lines[::-1]]


def _dist(a: Pt, b: Pt) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def hatch(polys: list[list[Pt]], spacing_mm: float, groups: Optional[list[Optional[int]]] = None,
          start: Pt = (0.0, 0.0)) -> list[list[Pt]]:
    """Scan lines for the fill. Each separate area is hatched on its own, and the areas are visited nearest
    first from `start`, so the head finishes one shape before moving to the next instead of crossing the
    whole bed on every row."""
    geom = region(polys, groups)
    if geom.is_empty:
        return []
    y_first = geom.bounds[1] + spacing_mm / 2
    areas = [ln for ln in (_rows(p, y_first, spacing_mm) for p in polygons_of(geom)) if ln]
    out: list[list[Pt]] = []
    cur = start
    if len(areas) <= GRID_ABOVE:
        left = list(range(len(areas)))
        while left:
            # entry point of each of _variants' four ways, without building them
            _, i, v = min((_dist(cur, e), i, v) for i in left
                          for v, e in enumerate((areas[i][0][0], areas[i][0][-1], areas[i][-1][-1], areas[i][-1][0])))
            left.remove(i)
            out += _variants(areas[i])[v]
            cur = out[-1][-1]
        return out
    # thousands of areas: pick each one's entry from two ends (first row or last row reversed)
    proxies = [[a[0][0], a[-1][-1]] for a in areas]
    first = {id(p[0]): i for i, p in enumerate(proxies)}
    for p in nearest_neighbour(proxies, cur):
        i = first.get(id(p[0]))
        out += areas[i] if i is not None else _variants(areas[first[id(p[-1])]])[2]
    return out
