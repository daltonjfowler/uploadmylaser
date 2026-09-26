"""Fill engraving as horizontal scan lines. This is how LightBurn's Fill mode moves on the RDC6445S
(test/golden/20mm_fill.rd): alternating-direction lines at a fixed spacing."""
from __future__ import annotations

from collections import defaultdict
from typing import Optional

from shapely.geometry import LineString, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from . import Pt


def _even_odd(polys: list[list[Pt]]) -> BaseGeometry:
    """XOR within one shape, so the holes in letters like 'O' and 'A' stay empty."""
    geom: BaseGeometry = Polygon()
    for pts in polys:
        if len(pts) < 4:
            continue
        p = Polygon(pts).buffer(0)  # repairs self-intersections
        if not p.is_empty:
            geom = geom.symmetric_difference(p)
    return geom


def region(polys: list[list[Pt]], groups: Optional[list[Optional[int]]] = None) -> BaseGeometry:
    """Even-odd inside each group, then union across groups."""
    if groups is None:
        return _even_odd(polys)
    by_group: dict[Optional[int], list[list[Pt]]] = defaultdict(list)
    for pts, g in zip(polys, groups):
        by_group[g].append(pts)
    return unary_union([_even_odd(v) for v in by_group.values()])


def hatch(polys: list[list[Pt]], spacing_mm: float, groups: Optional[list[Optional[int]]] = None) -> list[list[Pt]]:
    geom = region(polys, groups)
    if geom.is_empty:
        return []
    x0, y0, x1, y1 = geom.bounds
    lines: list[list[Pt]] = []
    y = y0 + spacing_mm / 2
    row = 0
    while y < y1:
        cut = geom.intersection(LineString([(x0 - 1, y), (x1 + 1, y)]))
        if isinstance(cut, LineString):
            segs = [cut]
        else:  # MultiLineString or GeometryCollection (may include touching points)
            segs = [g for g in getattr(cut, "geoms", []) if isinstance(g, LineString)]
        segs = sorted((s for s in segs if not s.is_empty and s.length > 0.01), key=lambda s: s.bounds[0])
        if row % 2:  # boustrophedon: alternate direction each row to cut travel time
            segs = [LineString(list(s.coords)[::-1]) for s in reversed(segs)]
        else:
            segs = [s if s.coords[0][0] <= s.coords[-1][0] else LineString(list(s.coords)[::-1]) for s in segs]
        lines += [[(float(x), float(yy)) for x, yy in s.coords] for s in segs]
        y += spacing_mm
        row += 1
    return lines
