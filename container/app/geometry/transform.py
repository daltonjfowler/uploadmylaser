"""Normalise a design to its own top-left corner, then scale/rotate/place it on the bed."""
from __future__ import annotations

from . import Item, Pt
from ..models import Placement


def bbox(items: list[Item]) -> tuple[float, float, float, float]:
    xs = [x for it in items for x, _ in it.pts]
    ys = [y for it in items for _, y in it.pts]
    return min(xs), min(ys), max(xs), max(ys)


def place(items: list[Item], p: Placement) -> list[Item]:
    x0, y0, x1, y1 = bbox(items)
    sx = p.scale
    sy = p.scale_y if p.scale_y is not None else p.scale  # stretch is in the part's own frame, before rotation
    w, h = (x1 - x0) * sx, (y1 - y0) * sy

    def tf(pt: Pt) -> Pt:
        x, y = (pt[0] - x0) * sx, (pt[1] - y0) * sy
        if p.rotate_deg == 90:      # clockwise, keeping the result's top-left at (0, 0)
            x, y = h - y, x
        elif p.rotate_deg == 180:
            x, y = w - x, h - y
        elif p.rotate_deg == 270:
            x, y = y, w - x
        return x + p.x_mm, y + p.y_mm

    return [Item(it.key, it.kind, [tf(pt) for pt in it.pts], it.closed, it.group) for it in items]
