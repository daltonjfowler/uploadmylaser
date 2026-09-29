"""Weld and Outline, on a part's Items after it is placed (bed mm, so distances are real millimetres).

Weld merges overlapping closed shapes of the same colour into one outline (cut-out script names,
overlapping stars). Outline adds a cut line a set distance around everything in the part, with an
optional keyring hole: the classic keychain. Both use shapely.
"""
from __future__ import annotations

from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import unary_union

from . import Item, Pt

OUTLINE_KEY = "outline"
RING_WALL_MM = 3.0  # wood around a keyring hole


def _rings_to_polygons(items: list[Item]) -> list[Polygon]:
    """Closed rings → polygons, even-odd inside each group (a letter's hole stays a hole)."""
    by_group: dict[object, list[Polygon]] = {}
    for it in items:
        if it.closed and len(it.pts) >= 3:
            poly = Polygon(it.pts).buffer(0)
            if not poly.is_empty:
                by_group.setdefault(it.group, []).append(poly)
    out: list[Polygon] = []
    for polys in by_group.values():
        shape = polys[0]
        for p in polys[1:]:
            shape = shape.symmetric_difference(p)
        out.append(shape)
    return out


def _polygons(g) -> list[Polygon]:
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def _ring(coords) -> list[Pt]:
    return [(float(x), float(y)) for x, y in coords]


def weld(items: list[Item]) -> list[Item]:
    """Closed shapes of the same colour and job become their merged outline. Open lines stay as they are."""
    out = [it for it in items if not it.closed]
    groups: dict[tuple[str, object], list[Item]] = {}
    for it in items:
        if it.closed:
            groups.setdefault((it.key, it.kind), []).append(it)
    for (key, kind), its in groups.items():
        merged = unary_union(_rings_to_polygons(its))
        group = its[0].group
        for poly in _polygons(merged):
            out.append(Item(key, kind, _ring(poly.exterior.coords), True, group))
            for hole in poly.interiors:
                out.append(Item(key, kind, _ring(hole.coords), True, group))
    return out


def outline(items: list[Item], dist_mm: float, hole_mm: float = 0.0) -> list[Item]:
    """A cut line `dist_mm` outside everything in the part; with `hole_mm`, a keyring hole on its left."""
    parts = _rings_to_polygons(items)
    parts += [LineString(it.pts).buffer(0.05) for it in items if not it.closed and len(it.pts) >= 2]
    if not parts:
        return []
    design = unary_union(parts)
    shape = design.buffer(dist_mm, quad_segs=16)
    extra: list[Item] = []
    if hole_mm > 0:
        r = hole_mm / 2
        x0, y0, _, y1 = design.bounds
        c = Point(x0 - max(dist_mm, 1.5) - r, (y0 + y1) / 2)  # just left of the design, clear of it
        shape = unary_union([shape, c.buffer(r + RING_WALL_MM, quad_segs=16)])
        extra.append(Item(OUTLINE_KEY, "cut", _ring(c.buffer(r, quad_segs=16).exterior.coords), True, None))
    rings = [Item(OUTLINE_KEY, "cut", _ring(p.exterior.coords), True, None) for p in _polygons(shape)]
    return rings + extra
