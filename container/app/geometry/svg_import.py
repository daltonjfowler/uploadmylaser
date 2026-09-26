"""SVG → Items using svgelements (handles transforms, viewBox, units, CSS)."""
from __future__ import annotations

import io
import math
import re

from svgelements import SVG, Close, Color, Line, Move, Path, Shape, SVGImage, SVGText

from . import ImportWarnings, Item, Pt
from .colors import classify_rgb, rgb_hex

PX_TO_MM = 25.4 / 96.0


def _visible(c: Color | None) -> bool:
    return c is not None and c.value is not None and c.alpha > 0


def _flatten(path: Path, tol_px: float) -> list[tuple[list[Pt], bool]]:
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
            pts = [(seg.end.x, seg.end.y)]
        elif isinstance(seg, Close):
            if pts and pts[0] != pts[-1]:
                pts.append(pts[0])
            closed = True
            flush()
        elif isinstance(seg, Line):
            if not pts:
                pts = [(seg.start.x, seg.start.y)]
            pts.append((seg.end.x, seg.end.y))
        else:  # curves and arcs
            if not pts:
                pts = [(seg.start.x, seg.start.y)]
            n = max(2, math.ceil(seg.length(error=1e-3) / tol_px))
            for i in range(1, n + 1):
                p = seg.point(i / n)
                pts.append((p.x, p.y))
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


def import_svg(data: bytes, warnings: ImportWarnings, tol_mm: float = 0.05) -> list[Item]:
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
        for pts_px, closed in _flatten(Path(el), tol_px):
            pts = [(x * PX_TO_MM, y * PX_TO_MM) for x, y in pts_px]
            # group per element: holes inside one path stay empty, and overlapping separate shapes stay filled (as SVG paints them)
            if s_key is not None:
                items.append(Item(s_key, s_kind, pts, closed, el_index))
            if f_key is not None and closed:
                items.append(Item(f_key, f_kind, pts, True, el_index))
    return items
