"""Weld and Outline, on a part's Items after it is placed (bed mm, so distances are real millimetres).

Weld merges overlapping closed shapes of the same colour into one outline (cut-out script names,
overlapping stars). Outline adds a cut line a set distance around everything in the part, with an
optional keyring hole: the classic keychain. Both use shapely.
"""
from __future__ import annotations

import math

from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import unary_union

from . import Item, Pt
from .areas import area_of, even_odd
from .photo_import import PHOTO_KEY

OUTLINE_KEY = "outline"
CLOSE_GAP_MM = 1.0  # "weld open ends closed" joins ends at most this far apart, on the bed
MAX_OPEN_TO_CLOSE = 50_000  # past this many open runs in one colour, only touching ends are joined
RING_WALL_MM = 3.0  # wood around a keyring hole


def _rings_to_polygons(items: list[Item]) -> list[Polygon]:
    """Closed rings → polygons, even-odd inside each group (a letter's hole stays a hole)."""
    by_group: dict[object, list] = {}
    for it in items:
        if it.closed and len(it.pts) >= 3:
            poly = area_of(it.pts)  # make_valid: a figure 8 keeps both loops
            if not poly.is_empty:
                by_group.setdefault(it.group, []).append(poly)
    return [even_odd(polys) for polys in by_group.values()]


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


def close_gaps(items: list[Item], gap_mm: float = CLOSE_GAP_MM) -> list[Item]:
    """Weld open ends closed (Dalton 2026-10-05: open shapes can't be engraved). Open lines of the same colour
    and fill group are chained where their ends touch, then ends at most `gap_mm` apart are joined, nearest
    first, and a run whose two ends meet becomes a closed shape. Nothing else changes: closed shapes are left
    exactly as they were and nothing is merged, so engraved holes stay holes."""
    from .order import join_paths

    out = [it for it in items if it.closed]
    groups: dict[tuple[str, object, object], list[Item]] = {}
    for it in items:
        if not it.closed:
            groups.setdefault((it.key, it.kind, it.group), []).append(it)
    for (key, kind, group), its in groups.items():
        runs = [list(p) for p in join_paths([it.pts for it in its])]
        done = [r for r in runs if len(r) >= 4 and r[0] == r[-1]]
        open_ = [r for r in runs if not (len(r) >= 4 and r[0] == r[-1])]
        if len(open_) <= MAX_OPEN_TO_CLOSE:
            open_ = _join_near(open_, gap_mm)
        for r in done:
            out.append(Item(key, kind, r, True, group))
        for r in open_:
            d = math.dist(r[0], r[-1])
            if len(r) >= 3 and d <= gap_mm:
                out.append(Item(key, kind, (r if d > 0 else r[:-1]) + [r[0]], True, group))
            else:
                out.append(Item(key, kind, r, False, group))
    return out


def _join_near(runs: list[list[Pt]], gap: float) -> list[list[Pt]]:
    """Join open runs end to end where two ends are within `gap`, closest pairs first. Near pairs are found
    once through a grid and linked in one pass, so thousands of runs stay fast."""
    runs = [r for r in runs if len(r) >= 2]
    if not runs or gap <= 0:
        return runs

    def pt(i: int, e: int) -> Pt:
        return runs[i][0] if e == 0 else runs[i][-1]

    cell: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for i in range(len(runs)):
        for e in (0, 1):
            x, y = pt(i, e)
            cell.setdefault((int(x // gap), int(y // gap)), []).append((i, e))
    pairs = []
    for (cx, cy), here in cell.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for a in here:
                    for b in cell.get((cx + dx, cy + dy), ()):
                        if a < b and a[0] != b[0]:  # a run's own two ends close it later, not here
                            d = math.dist(pt(*a), pt(*b))
                            if d <= gap:
                                pairs.append((d, a, b))
    pairs.sort()
    link: dict[tuple[int, int], tuple[int, int]] = {}
    for _, a, b in pairs:
        if a not in link and b not in link:
            link[a], link[b] = b, a
    used = [False] * len(runs)

    def walk(i: int, e: int) -> list[Pt]:
        """From run i, entering at end e, follow the links; the joined points."""
        pts: list[Pt] = []
        while not used[i]:
            used[i] = True
            pts += runs[i] if e == 0 else runs[i][::-1]
            nxt = link.get((i, 1 - e))
            if nxt is None:
                break
            i, e = nxt
        return pts

    out: list[list[Pt]] = []
    for i in range(len(runs)):  # chains with a free end first
        for e in (0, 1):
            if not used[i] and (i, e) not in link:
                out.append(walk(i, e))
    for i in range(len(runs)):  # what is left are rings of links: closed by close_gaps
        if not used[i]:
            out.append(walk(i, 0))
    return out


def outline(items: list[Item], dist_mm: float, hole_mm: float = 0.0) -> list[Item]:
    """A cut line `dist_mm` outside everything in the part; with `hole_mm`, a keyring hole on its left."""
    photo = [pt for it in items if it.key == PHOTO_KEY for pt in it.pts]
    items = [it for it in items if it.key != PHOTO_KEY]
    parts = _rings_to_polygons(items)
    parts += [LineString(it.pts).buffer(0.05) for it in items if not it.closed and len(it.pts) >= 2]
    if photo:  # thousands of dot lines: the photo's rectangle is what a photo tag needs
        xs = [x for x, _ in photo]
        ys = [y for _, y in photo]
        parts.append(Polygon([(min(xs), min(ys)), (max(xs), min(ys)), (max(xs), max(ys)), (min(xs), max(ys))]))
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
