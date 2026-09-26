"""Colour → operation convention taught to students (matches the teacher's three presets):

    black = cut through     red = mark (light line)     blue = engrave (filled)

Internally "mark" is the op kind "score". Students only ever see the word "Mark".
"""
from __future__ import annotations

from typing import Optional

from ..models import OpKind


def classify_rgb(r: int, g: int, b: int) -> Optional[OpKind]:
    if r < 80 and g < 80 and b < 80:
        return "cut"
    if r > 180 and g < 90 and b < 90:
        return "score"
    if b > 180 and r < 90 and g < 140:
        return "engrave"
    return None


def rgb_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


# AutoCAD Color Index: 7 = black/white (black on paper), 1 = red, 5 = blue.
DXF_LAYER_WORDS: dict[str, OpKind] = {"CUT": "cut", "MARK": "score", "SCORE": "score", "ENGRAVE": "engrave"}


def classify_dxf(layer: str, aci: int) -> Optional[OpKind]:
    name = layer.upper()
    for word, kind in DXF_LAYER_WORDS.items():
        if word in name:
            return kind
    return {7: "cut", 1: "score", 5: "engrave"}.get(aci)
