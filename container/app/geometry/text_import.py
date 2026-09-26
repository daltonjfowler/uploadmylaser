"""Text → outline Items using fontTools and bundled fonts. Height is cap height in mm.

Font ids must match TEXT_FONTS in shared/contracts.ts. Files are installed by the Dockerfile.
"""
from __future__ import annotations

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from svgelements import Path

from . import ImportWarnings, Item
from ..models import TextSpec
from .svg_import import _flatten

_DEJAVU = "/usr/share/fonts/truetype/dejavu"
_UML = "/usr/share/fonts/truetype/uml"  # downloaded from github.com/google/fonts in the Dockerfile
FONTS = {
    "sans": f"{_DEJAVU}/DejaVuSans-Bold.ttf",
    "serif": f"{_DEJAVU}/DejaVuSerif-Bold.ttf",
    "block": f"{_UML}/Anton-Regular.ttf",
    "chunky": f"{_UML}/Bungee-Regular.ttf",
    "marker": f"{_UML}/PermanentMarker-Regular.ttf",
    "script": f"{_UML}/Pacifico-Regular.ttf",
    "stencil": f"{_UML}/AllertaStencil-Regular.ttf",
}
# Joined-up letters overlap, so cutting them out gives messy, fragile parts.
CUT_UNFRIENDLY = {"script", "marker"}
_cache: dict[str, TTFont] = {}


def _font(name: str) -> TTFont:
    path = FONTS.get(name, FONTS["sans"])
    if path not in _cache:
        _cache[path] = TTFont(path)
    return _cache[path]


def import_text(spec: TextSpec, warnings: ImportWarnings, tol_mm: float = 0.05) -> list[Item]:
    if spec.font not in FONTS:
        warnings.add("That font isn't available, so we used Sans.")
    if spec.op == "cut" and spec.font in CUT_UNFRIENDLY:
        warnings.add("Joined-up fonts come out messy when cut through. Try Engrave, or the Stencil font.")
    elif spec.op == "cut" and spec.font != "stencil":
        warnings.add("Cut-out letters lose their middles (O, A, B…). The Stencil font keeps them.")
    font = _font(spec.font)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    cap = getattr(font["OS/2"], "sCapHeight", 0) or font["head"].unitsPerEm * 0.7
    k = spec.height_mm / cap  # font units → mm

    items: list[Item] = []
    pen_x = 0.0
    for gi, ch in enumerate(spec.value):
        gname = cmap.get(ord(ch))
        if gname is None:
            warnings.add(f"The font has no '{ch}', so it was skipped.")
            continue
        pen = SVGPathPen(glyphs)
        glyphs[gname].draw(pen)
        d = pen.getCommands()
        if d:
            for pts, closed in _flatten(Path(d), tol_mm / k):
                mm = [((pen_x + x) * k, (cap - y) * k) for x, y in pts]  # flip y: font is y-up
                # one group per letter, so overlapping script letters fill as a union instead of cancelling out
                items.append(Item("text", spec.op, mm, closed, group=gi))
        pen_x += hmtx[gname][0]
    return items
