"""Path ordering: cut inner shapes before the shapes that contain them (otherwise the part drops
out before its holes are cut), then nearest-neighbour to reduce travel."""
from __future__ import annotations

import math

from shapely.geometry import Polygon

from . import Pt

MAX_CONTAINMENT_CHECK = 800  # O(n^2); student designs are small, so skip depth sorting beyond this


def _dist(a: Pt, b: Pt) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def nearest_neighbour(paths: list[list[Pt]], start: Pt = (0.0, 0.0), allow_reverse: bool = True) -> list[list[Pt]]:
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
