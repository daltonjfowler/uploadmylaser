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


class ImportWarnings(list):
    def add(self, msg: str) -> None:
        if msg not in self:
            self.append(msg)
