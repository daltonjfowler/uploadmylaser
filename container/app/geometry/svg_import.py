"""SVG → Items using svgelements (handles transforms, viewBox, units, CSS)."""
from __future__ import annotations

import io
import math
import re

import numpy as np
from svgelements import SVG, Close, Color, Line, Move, Path, Shape, SVGImage, SVGText

from . import ImportWarnings, Item, PointBudget, Pt
from .colors import classify_rgb, rgb_hex

PX_TO_MM = 25.4 / 96.0
# Points for one curve. Past this the curve is flattened more coarsely: at 0.05 mm steps that is a
# 1 m long curve, bigger than any laser bed, so real designs never reach it.
MAX_SEGMENT_POINTS = 20_000
# Curves longer than this (px) skip svgelements' exact length: its absolute error target makes it
# recurse millions of times on a curve with huge coordinates.
EXACT_LENGTH_PX = 100_000


def _visible(c: Color | None) -> bool:
    return c is not None and c.value is not None and c.alpha > 0


def _rough_length(seg) -> float:
    """Chord length through 17 points: cheap, and close enough to size the flattening."""
    xy = seg.npoint(np.linspace(0.0, 1.0, 17))
    return float(np.hypot(*np.diff(xy, axis=0).T).sum())


def _flatten(path: Path, tol_px: float, budget: PointBudget | None = None) -> list[tuple[list[Pt], bool]]:
    budget = budget or PointBudget()
    out: list[tuple[list[Pt], bool]] = []
    pts: list[Pt] = []
    closed = False

    def flush() -> None:
        nonlocal pts, closed
        if len(pts) >= 2:
            out.append((pts, closed))
        pts, closed = [], False

    for seg in path:
        if isinstance(seg, Move):
            flush()
            budget.take()
            pts = [(seg.end.x, seg.end.y)]
        elif isinstance(seg, Close):
            if pts and pts[0] != pts[-1]:
                pts.append(pts[0])
            closed = True
            flush()
        elif isinstance(seg, Line):
            if not pts:
                budget.take()
                pts = [(seg.start.x, seg.start.y)]
            budget.take()
            pts.append((seg.end.x, seg.end.y))
        else:  # curves and arcs
            if not pts:
                budget.take()
                pts = [(seg.start.x, seg.start.y)]
            length = _rough_length(seg)
            if length < EXACT_LENGTH_PX:
                length = seg.length(error=1e-3)
            n = min(MAX_SEGMENT_POINTS, max(2, math.ceil(length / tol_px)))  # ceil raises on inf/NaN
            budget.take(n)
            xy = seg.npoint(np.arange(1, n + 1) / n).tolist()  # numpy: 20 000 points in a blink, not seconds
            end = seg.point(1.0)
            xy[-1] = (end.x, end.y)  # exactly, so the next segment joins up
            pts += [(x, y) for x, y in xy]
    flush()
    return out


_ROOT_TAG = re.compile(rb"<svg\b([^>]*)>", re.IGNORECASE)


def _no_default_fill(data: bytes) -> bytes:
    """SVG's implicit default fill is black, which would mean "cut". svgelements fills that default in
    itself, so give the root fill="none" instead: anything that sets a fill (element, group, CSS) still wins."""
    m = _ROOT_TAG.search(data)
    if m is None or re.search(rb"\bfill\s*=", m.group(1)):
        return data
    return data[:m.end(1)] + b' fill="none"' + data[m.end(1):]


def import_svg(data: bytes, warnings: ImportWarnings, tol_mm: float = 0.05, budget: PointBudget | None = None) -> list[Item]:
    budget = budget or PointBudget()
    svg = SVG.parse(io.BytesIO(_no_default_fill(data)), reify=True, ppi=96.0)
    tol_px = tol_mm / PX_TO_MM
    items: list[Item] = []
    for el_index, el in enumerate(svg.elements()):
        if isinstance(el, SVGText):
            warnings.add("Text in the SVG was skipped. Convert text to paths (outlines) first, or use the Text tool.")
            continue
        if isinstance(el, SVGImage):
            warnings.add("Pictures inside the SVG were skipped. Only lines and shapes can be lasered.")
            continue
        if not isinstance(el, Shape):
            continue
        if el.values.get("visibility") == "hidden" or el.values.get("display") == "none":
            continue
        stroke = el.stroke if _visible(el.stroke) else None
        fill = el.fill if _visible(el.fill) else None  # default is none: see _no_default_fill
        if stroke is None and fill is None:
            continue
        s_key = s_kind = f_key = f_kind = None
        if stroke is not None:
            s_key, s_kind = f"stroke:{rgb_hex(stroke.red, stroke.green, stroke.blue)}", classify_rgb(stroke.red, stroke.green, stroke.blue)
        if fill is not None:
            f_key, f_kind = f"fill:{rgb_hex(fill.red, fill.green, fill.blue)}", classify_rgb(fill.red, fill.green, fill.blue)
            if s_key is not None and f_kind == s_kind and f_kind is not None:
                f_key = None  # same op either way (e.g. black stroke + black fill): emit once, not twice
        for pts_px, closed in _flatten(Path(el), tol_px, budget):
            pts = [(x * PX_TO_MM, y * PX_TO_MM) for x, y in pts_px]
            if not all(math.isfinite(c) for p in pts for c in p):  # NaN/inf: the pipeline says "couldn't read"
                raise ValueError("SVG coordinates are not finite")
            # group per element: holes inside one path stay empty, and overlapping separate shapes stay filled (as SVG paints them)
            if s_key is not None:
                items.append(Item(s_key, s_kind, pts, closed, el_index))
            if f_key is not None and closed:
                items.append(Item(f_key, f_kind, pts, True, el_index))
    return items
