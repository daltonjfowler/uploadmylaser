"""Rings → areas, and even-odd fill, shared by hatching, weld/outline and cut ordering."""
from __future__ import annotations

from shapely import STRtree, make_valid
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from . import Pt


def polygons_of(g: BaseGeometry) -> list[Polygon]:
    """The polygon parts of any geometry (lines and points dropped)."""
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    out: list[Polygon] = []
    for p in getattr(g, "geoms", []):
        out += polygons_of(p) if not isinstance(p, Polygon) else [p]
    return out


def area_of(pts: list[Pt]) -> Polygon | MultiPolygon:
    """The area a ring encloses, keeping every lobe of a self-crossing ring: a figure 8 keeps both loops,
    where buffer(0) would drop one of them."""
    if len(pts) < 3:
        return Polygon()
    g = Polygon(pts)
    if g.is_valid:
        return g
    g = make_valid(g)
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    parts = polygons_of(g)
    return MultiPolygon(parts) if len(parts) > 1 else (parts[0] if parts else Polygon())


def _xor_all(geoms: list[BaseGeometry]) -> BaseGeometry:
    """Balanced pairwise XOR: each overlay works on two halves of similar size, not on a growing result
    against one more shape (that was quadratic: 1000 shapes took 23 s)."""
    while len(geoms) > 1:
        nxt = [geoms[i].symmetric_difference(geoms[i + 1]) for i in range(0, len(geoms) - 1, 2)]
        if len(geoms) % 2:
            nxt.append(geoms[-1])
        geoms = nxt
    return geoms[0]


def even_odd(geoms: list[BaseGeometry]) -> BaseGeometry:
    """Even-odd fill of the shapes: a point is inside when an odd number of shapes cover it (the hole in an
    'O' stays empty). Shapes that touch nothing else are kept as they are; only shapes that touch or overlap
    are XORed together, a cluster at a time."""
    geoms = [g for g in geoms if not g.is_empty]
    if not geoms:
        return Polygon()
    parent = list(range(len(geoms)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    a, b = STRtree(geoms).query(geoms, predicate="intersects")
    for i, j in zip(a.tolist(), b.tolist()):
        ri, rj = root(i), root(j)
        if ri != rj:
            parent[ri] = rj
    clusters: dict[int, list[BaseGeometry]] = {}
    for i, g in enumerate(geoms):
        clusters.setdefault(root(i), []).append(g)
    # different clusters don't even touch, so their pieces together are a valid MultiPolygon
    parts = [p for c in clusters.values() for p in polygons_of(_xor_all(c))]
    if not parts:
        return Polygon()
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)
