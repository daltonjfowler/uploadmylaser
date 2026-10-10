"""Path ordering: cut inner shapes before the shapes that contain them (otherwise the part drops
out before its holes are cut), then nearest-neighbour to reduce travel."""
from __future__ import annotations

import math

import numpy as np
import shapely
from shapely import STRtree

from . import Pt
from .areas import area_of

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


CLOSE_ENOUGH_MM = 0.5  # an outline whose ends miss by less than this still frees a part when it is cut


RING_ENTRIES = 32  # a closed shape can be entered at up to this many of its corners
LINEAR_BELOW = 256  # fewer ready entry points than this: just check them all


def _closes(p: list[Pt]) -> bool:
    return len(p) >= 4 and _dist(p[0], p[-1]) <= CLOSE_ENOUGH_MM


def _containers(paths: list[list[Pt]]) -> list[list[int]]:
    """For each path, every bigger shape that holds it. Shapes are closed paths, paths whose ends miss by
    under 0.5 mm (a DXF polyline without its closed flag, an SVG path without Z), and the area an open path
    wraps, so an open outline around a hole still waits for the hole."""
    n = len(paths)
    area = [0.0] * n
    shapes: dict[int, object] = {}
    for i, p in enumerate(paths):
        if len(p) >= 3:
            g = area_of(p)
            if not g.is_empty and g.area > 0:
                shapes[i], area[i] = g, g.area
    # where each path sits: a point inside a shape, or the middle of an open line (shapely, all at once)
    at = np.empty(n, dtype=object)
    lines = [i for i in range(n) if not (i in shapes and _closes(paths[i]))]
    rings = [i for i in range(n) if i in shapes and _closes(paths[i])]
    if rings:
        at[rings] = shapely.point_on_surface([shapes[i] for i in rings])
    if lines:
        pts = [paths[i] if len(paths[i]) >= 2 else paths[i] * 2 for i in lines]
        coords = np.array([xy for p in pts for xy in p], dtype=float)
        idx = np.repeat(np.arange(len(pts)), [len(p) for p in pts])
        at[lines] = shapely.line_interpolate_point(shapely.linestrings(coords, indices=idx), 0.5, normalized=True)
    out: list[list[int]] = [[] for _ in range(n)]
    if shapes:
        holders = list(shapes)
        tree = STRtree([shapes[i] for i in holders])
        for k, t in zip(*tree.query(at, predicate="within").tolist()):
            j = holders[t]
            if j != k and area[j] > area[k]:
                out[k].append(j)
    return out


def _batches(order: list[int], containers: list[list[int]]) -> list[list[int]]:
    """Split the cut order where a path holds something earlier in the same batch. The encoder runs every
    pass of a batch before the next, so a part's holes get all their passes before its outline starts."""
    out: list[list[int]] = []
    holders: set[int] = set()
    for i in order:
        if not out or i in holders:
            out.append([])
            holders = set()
        out[-1].append(i)
        holders.update(containers[i])
    return out


def _by_depth(paths: list[list[Pt]], containers: list[list[int]], start: Pt) -> tuple[list[int], list[list[Pt]]]:
    """Huge path counts: deepest first, open lines then shapes within a depth, each swept in bands like
    _sweep. Keeps holes before outlines without the per-step search."""
    depth = [len(c) for c in containers]

    def key(i: int) -> tuple[int, float]:
        band = int(paths[i][0][1] // SWEEP_BAND_MM)
        return band, paths[i][0][0] if band % 2 == 0 else -paths[i][0][0]

    order: list[int] = []
    out: list[list[Pt]] = []
    cur = start
    for d in sorted(set(depth), reverse=True):
        for want_closed in (False, True):
            for i in sorted((i for i in range(len(paths)) if depth[i] == d and _closes(paths[i]) == want_closed), key=key):
                p = paths[i]
                if p[0] != p[-1] and _dist(cur, p[-1]) < _dist(cur, p[0]):
                    p = p[::-1]
                order.append(i)
                out.append(p)
                cur = p[-1]
    return order, out


def _nearest_ready(paths: list[list[Pt]], containers: list[list[int]], start: Pt) -> tuple[list[int], list[list[Pt]]]:
    """Greedy: from where the head is, cut the nearest path that is ready. A path is ready once everything
    inside it has been cut. A closed shape is entered at its nearest corner (same direction), an open line
    at either end. Ready entry points live in a grid, searched ring by ring around the head."""
    n = len(paths)
    remaining = [0] * n
    for cs in containers:
        for j in cs:
            remaining[j] += 1
    entries: list[list[tuple[Pt, int, int]]] = []  # per path: (point, path, how: -1 reversed, else start index)
    for i, p in enumerate(paths):
        if len(p) >= 4 and p[0] == p[-1]:
            step = max(1, (len(p) - 1) // RING_ENTRIES)
            entries.append([(p[k], i, k) for k in range(0, len(p) - 1, step)])
        elif p[0] != p[-1]:
            entries.append([(p[0], i, 0), (p[-1], i, -1)])
        else:
            entries.append([(p[0], i, 0)])
    xs = [e[0][0] for es in entries for e in es]
    ys = [e[0][1] for es in entries for e in es]
    x0, y0 = min(xs), min(ys)
    size = max(max(max(xs) - x0, max(ys) - y0) / math.sqrt(n), 1.0)
    nx, ny = int((max(xs) - x0) // size) + 1, int((max(ys) - y0) // size) + 1

    def cell(pt: Pt) -> tuple[int, int]:
        return int((pt[0] - x0) // size), int((pt[1] - y0) // size)

    cells: dict[tuple[int, int], list[tuple[Pt, int, int]]] = {}
    live = 0

    def add(i: int) -> None:
        nonlocal live
        for e in entries[i]:
            cells.setdefault(cell(e[0]), []).append(e)
        live += len(entries[i])

    def drop(i: int) -> None:
        nonlocal live
        for c in {cell(e[0]) for e in entries[i]}:
            bucket = [e for e in cells[c] if e[1] != i]
            if bucket:
                cells[c] = bucket
            else:
                del cells[c]
        live -= len(entries[i])

    def nearest(cur: Pt) -> tuple[Pt, int, int]:
        if live < LINEAR_BELOW:
            return min((e for b in cells.values() for e in b), key=lambda e: _dist(cur, e[0]))
        cx, cy = cell(cur)
        best, best_d, r = None, float("inf"), 0
        while True:
            for gx in range(cx - r, cx + r + 1):
                for gy in (range(cy - r, cy + r + 1) if gx in (cx - r, cx + r) else (cy - r, cy + r)):
                    for e in cells.get((gx, gy), ()):
                        d = _dist(cur, e[0])
                        if d < best_d:
                            best, best_d = e, d
            # anything in ring r+1 or beyond is at least r*size away (the head may sit anywhere in its cell)
            if best is not None and (best_d <= r * size or r > nx + ny + abs(cx) + abs(cy)):
                return best
            r += 1

    for i in range(n):
        if remaining[i] == 0:
            add(i)
    order: list[int] = []
    out: list[list[Pt]] = []
    cur = start
    for _ in range(n):
        _, i, how = nearest(cur)
        drop(i)
        p = paths[i]
        if how == -1:
            p = p[::-1]
        elif how > 0:  # closed: start at that corner, same direction
            p = p[how:-1] + p[:how] + [p[how]]
        order.append(i)
        out.append(p)
        cur = p[-1]
        for j in containers[i]:
            remaining[j] -= 1
            if remaining[j] == 0:
                add(j)
    return order, out


def order_cut_groups(paths: list[list[Pt]], start: Pt = (0.0, 0.0)) -> list[list[list[Pt]]]:
    """The cut layer's paths in cutting order, split into batches (see _batches). Everything inside a shape
    is cut before the shape, so a part always comes free last; otherwise the nearest path goes next, so the
    head finishes one part before moving on."""
    paths = [p for p in paths if p]
    if not paths:
        return []
    containers = _containers(paths)
    if len(paths) > MAX_NEAREST:
        order, out = _by_depth(paths, containers, start)
    else:
        order, out = _nearest_ready(paths, containers, start)
    where = {i: k for k, i in enumerate(order)}
    return [[out[where[i]] for i in b] for b in _batches(order, containers)]


def order_cuts(paths: list[list[Pt]], start: Pt = (0.0, 0.0)) -> list[list[Pt]]:
    return [p for g in order_cut_groups(paths, start) for p in g]


JOIN_TOL_MM = 0.05


def join_paths(paths: list[list[Pt]], tol: float = JOIN_TOL_MM) -> list[list[Pt]]:
    """Drop exact repeats and chain open lines whose ends touch into single paths.

    CAD files often draw a rectangle as four loose LINEs, or the same line twice (blocks, stacked layers).
    Joined, the head cuts each outline in one go, never cuts a line twice, and a chain that closes counts
    as a shape, so it is cut after its holes. Only the order and direction of points change."""
    def key(pt: Pt) -> tuple[int, int]:
        return round(pt[0] / tol), round(pt[1] / tol)

    def near(a: Pt, b: Pt) -> bool:
        return _dist(a, b) <= tol

    def ring_key(k: tuple[tuple[int, int], ...]) -> tuple[tuple[int, int], ...]:
        """The same closed shape from any start corner, either way round, gives the same key."""
        body = k[:-1]
        best = None
        for seq in (body, body[::-1]):
            s0 = min(range(len(seq)), key=lambda i: seq[i:] + seq[:i])
            cand = seq[s0:] + seq[:s0]
            best = cand if best is None or cand < best else best
        return best

    seen: set[tuple[tuple[int, int], ...]] = set()
    closed: list[list[Pt]] = []
    open_: list[list[Pt]] = []
    for p in paths:
        if len(p) < 2:
            continue
        k = tuple(key(pt) for pt in p)
        is_closed = len(p) >= 4 and (k[0] == k[-1] or near(p[0], p[-1]))
        if is_closed:
            k = ("ring",) + ring_key(k[:-1] + (k[0],))
            if k in seen:
                continue
        elif k in seen or k[::-1] in seen:
            continue
        seen.add(k)
        (closed if is_closed else open_).append(p)

    ends: dict[tuple[int, int], list[int]] = {}
    for i, p in enumerate(open_):
        ends.setdefault(key(p[0]), []).append(i)
        ends.setdefault(key(p[-1]), []).append(i)
    used = [False] * len(open_)

    def take(at: Pt) -> list[Pt] | None:
        """An unused path with an end within `tol` of `at`, turned to start there. Neighbouring cells are
        looked at too: two ends 1e-7 apart can round into different cells."""
        cx, cy = key(at)
        for dx in (0, -1, 1):
            for dy in (0, -1, 1):
                for j in ends.get((cx + dx, cy + dy), ()):
                    if used[j]:
                        continue
                    q = open_[j]
                    if near(q[0], at):
                        used[j] = True
                        return q
                    if near(q[-1], at):
                        used[j] = True
                        return q[::-1]
        return None

    out = list(closed)
    for i, p in enumerate(open_):
        if used[i]:
            continue
        used[i] = True
        chain = list(p)
        while not near(chain[-1], chain[0]) and (q := take(chain[-1])) is not None:
            chain += q[1:]
        while not near(chain[-1], chain[0]) and (q := take(chain[0])) is not None:
            chain = q[::-1] + chain[1:]
        if len(chain) >= 4 and near(chain[0], chain[-1]):
            chain[-1] = chain[0]  # exactly closed, so ordering sees a shape
        out.append(chain)
    return out
