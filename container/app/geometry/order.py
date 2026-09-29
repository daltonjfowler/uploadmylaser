"""Path ordering: cut inner shapes before the shapes that contain them (otherwise the part drops
out before its holes are cut), then nearest-neighbour to reduce travel."""
from __future__ import annotations

import math

from shapely import STRtree
from shapely.geometry import Polygon

from . import Pt

GRID_ABOVE = 300  # more paths than this: nearest-neighbour through a grid instead of checking every path
MAX_NEAREST = 50_000  # above this even the grid is too slow: sweep in bands instead
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
    if len(paths) > GRID_ABOVE:
        return _grid_nearest(paths, start, allow_reverse)
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


def _grid_nearest(paths: list[list[Pt]], start: Pt, allow_reverse: bool) -> list[list[Pt]]:
    """The same greedy nearest-neighbour, but each step only looks at grid cells near the head, ring by
    ring, stopping once no unvisited cell can hold anything closer. Big floorplans have thousands of shapes."""
    ends: list[tuple[Pt, int, bool]] = []  # (point, path, reversed)
    for i, p in enumerate(paths):
        ends.append((p[0], i, False))
        if allow_reverse and p[0] != p[-1]:
            ends.append((p[-1], i, True))
    xs = [e[0][0] for e in ends]
    ys = [e[0][1] for e in ends]
    x0, y0 = min(xs), min(ys)
    size = max(max(max(xs) - x0, max(ys) - y0) / math.sqrt(len(paths)), 1.0)
    cells: dict[tuple[int, int], list[tuple[Pt, int, bool]]] = {}
    for e in ends:
        cells.setdefault((int((e[0][0] - x0) // size), int((e[0][1] - y0) // size)), []).append(e)
    nx = int((max(xs) - x0) // size) + 1
    ny = int((max(ys) - y0) // size) + 1
    used = [False] * len(paths)
    out: list[list[Pt]] = []
    cur = start
    for _ in range(len(paths)):
        cx, cy = int((cur[0] - x0) // size), int((cur[1] - y0) // size)
        best: tuple[Pt, int, bool] | None = None
        best_d = float("inf")
        r = 0
        while True:
            for gx in range(cx - r, cx + r + 1):
                for gy in (range(cy - r, cy + r + 1) if gx in (cx - r, cx + r) else (cy - r, cy + r)):
                    bucket = cells.get((gx, gy))
                    if not bucket:
                        continue
                    for e in bucket:
                        d = _dist(cur, e[0])
                        if d < best_d:
                            best, best_d = e, d
            # anything in ring r+1 or beyond is at least r*size away (the head may sit anywhere in its cell)
            if best is not None and best_d <= r * size:
                break
            r += 1
            if r > nx + ny + abs(cx) + abs(cy):  # searched past the whole grid
                break
        assert best is not None
        _, i, rev = best
        used[i] = True
        p = paths[i]
        for pt in (p[0], p[-1]):  # take both of its ends out of the grid
            bucket = cells.get((int((pt[0] - x0) // size), int((pt[1] - y0) // size)))
            if bucket:
                bucket[:] = [e for e in bucket if e[1] != i]
        p = p[::-1] if rev else p
        out.append(p)
        cur = p[-1]
    return out


def order_cuts(paths: list[list[Pt]]) -> list[list[Pt]]:
    closed = [p for p in paths if len(p) >= 4 and p[0] == p[-1]]
    open_ = [p for p in paths if not (len(p) >= 4 and p[0] == p[-1])]
    polys = [Polygon(p).buffer(0) for p in closed]
    # depth = how many bigger outlines hold it; the index only offers outlines whose box covers the point
    tree = STRtree(polys)
    depth = []
    for i, pi in enumerate(polys):
        d = 0
        if not pi.is_empty:
            rp = pi.representative_point()
            for j in tree.query(rp):
                pj = polys[int(j)]
                if int(j) != i and not pj.is_empty and pj.area > pi.area and pj.contains(rp):
                    d += 1
        depth.append(d)
    ordered: list[list[Pt]] = nearest_neighbour(open_)  # open lines first: they never free a part
    cur = ordered[-1][-1] if ordered else (0.0, 0.0)
    for d in sorted(set(depth), reverse=True):  # deepest (innermost) first
        group = nearest_neighbour([closed[i] for i in range(len(closed)) if depth[i] == d], cur, allow_reverse=False)
        ordered += group
        cur = group[-1][-1]
    return ordered
