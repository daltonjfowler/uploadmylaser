"""Path ordering: cut inner shapes before the shapes that contain them (otherwise the part drops
out before its holes are cut), then nearest-neighbour to reduce travel."""
from __future__ import annotations

import math

from shapely.geometry import Polygon

from . import Pt

MAX_CONTAINMENT_CHECK = 800  # O(n^2); student designs are small, so skip depth sorting beyond this
MAX_NEAREST = 2_000  # nearest-neighbour is O(n^2) too; above this, sweep in bands instead
SWEEP_BAND_MM = 10.0


def _dist(a: Pt, b: Pt) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _sweep(paths: list[list[Pt]], start: Pt, allow_reverse: bool) -> list[list[Pt]]:
    """Cheap order for huge path counts: bands top to bottom, left-right then right-left."""
    def key(p: list[Pt]) -> tuple[int, float]:
        band = int(p[0][1] // SWEEP_BAND_MM)
        return band, p[0][0] if band % 2 == 0 else -p[0][0]

    out: list[list[Pt]] = []
    cur = start
    for p in sorted(paths, key=key):
        if allow_reverse and p[0] != p[-1] and _dist(cur, p[-1]) < _dist(cur, p[0]):
            p = p[::-1]
        out.append(p)
        cur = p[-1]
    return out


def nearest_neighbour(paths: list[list[Pt]], start: Pt = (0.0, 0.0), allow_reverse: bool = True) -> list[list[Pt]]:
    if len(paths) > MAX_NEAREST:
        return _sweep(paths, start, allow_reverse)
    left = list(paths)
    out: list[list[Pt]] = []
    cur = start
    while left:
        best_i, best_d, best_rev = 0, float("inf"), False
        for i, p in enumerate(left):
            d = _dist(cur, p[0])
            if d < best_d:
                best_i, best_d, best_rev = i, d, False
            if allow_reverse and p[0] != p[-1]:
                d = _dist(cur, p[-1])
                if d < best_d:
                    best_i, best_d, best_rev = i, d, True
        p = left.pop(best_i)
        if best_rev:
            p = p[::-1]
        out.append(p)
        cur = p[-1]
    return out


def order_cuts(paths: list[list[Pt]]) -> list[list[Pt]]:
    closed = [p for p in paths if len(p) >= 4 and p[0] == p[-1]]
    open_ = [p for p in paths if not (len(p) >= 4 and p[0] == p[-1])]
    if len(closed) > MAX_CONTAINMENT_CHECK:
        return nearest_neighbour(open_ + closed)
    polys = [Polygon(p).buffer(0) for p in closed]
    depth = []
    for i, pi in enumerate(polys):
        d = 0
        rp = pi.representative_point() if not pi.is_empty else None
        for j, pj in enumerate(polys):
            if i != j and rp is not None and not pj.is_empty and pj.area > pi.area and pj.contains(rp):
                d += 1
        depth.append(d)
    ordered: list[list[Pt]] = nearest_neighbour(open_)  # open lines first: they never free a part
    cur = ordered[-1][-1] if ordered else (0.0, 0.0)
    for d in sorted(set(depth), reverse=True):  # deepest (innermost) first
        group = nearest_neighbour([closed[i] for i in range(len(closed)) if depth[i] == d], cur, allow_reverse=False)
        ordered += group
        cur = group[-1][-1]
    return ordered
