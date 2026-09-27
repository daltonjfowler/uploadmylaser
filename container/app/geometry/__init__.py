"""Geometry pipeline: design files → mm polylines tagged by operation.

Shared shape for every importer:
    Item(key, kind, pts, closed)
where `key` identifies the source colour/layer (e.g. "stroke:#ff0000", "dxf:CUT") and `kind` is the
op it maps to, or None when the student still has to choose.
Coordinates are mm, origin top-left, y down (same as the bed).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..models import OpKind

Pt = tuple[float, float]


@dataclass
class Item:
    key: str
    kind: Optional[OpKind]
    pts: list[Pt]
    closed: bool
    # Fill rule scope for engraving: outlines in the same group combine even-odd (holes stay empty), and
    # different groups are unioned (overlapping letters or shapes both stay filled). None = one shared group.
    group: Optional[int] = None


# Points in one whole job. Importers count as they go (PointBudget), so a hostile file fails fast
# instead of building millions of points first.
MAX_POINTS = 300_000
TOO_DETAILED = "This design is too detailed. Simplify it and try again."


class TooDetailed(ValueError):
    def __init__(self) -> None:
        super().__init__(TOO_DETAILED)


class PointBudget:
    """Running point count shared by every part of one job."""

    def __init__(self, limit: int = MAX_POINTS) -> None:
        self.left = limit

    def take(self, n: int = 1) -> None:
        self.left -= n
        if self.left < 0:
            raise TooDetailed()


class ImportWarnings(list):
    def add(self, msg: str) -> None:
        if msg not in self:
            self.append(msg)
