"""Text → outline Items using fontTools and bundled fonts. Height is cap height in mm.

Font ids must match TEXT_FONTS in shared/contracts.ts. Files are installed by the Dockerfile.
"""
from __future__ import annotations

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from svgelements import Path

from . import ImportWarnings, Item, PointBudget
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
    "bebas": f"{_UML}/BebasNeue-Regular.ttf",
    "staatliches": f"{_UML}/Staatliches-Regular.ttf",
    "archivo-black": f"{_UML}/ArchivoBlack-Regular.ttf",
    "russo": f"{_UML}/RussoOne-Regular.ttf",
    "passion": f"{_UML}/PassionOne-Regular.ttf",
    "titan": f"{_UML}/TitanOne-Regular.ttf",
    "luckiest": f"{_UML}/LuckiestGuy-Regular.ttf",
    "bowlby": f"{_UML}/BowlbyOneSC-Regular.ttf",
    "ultra": f"{_UML}/Ultra-Regular.ttf",
    "alfa-slab": f"{_UML}/AlfaSlabOne-Regular.ttf",
    "abril": f"{_UML}/AbrilFatface-Regular.ttf",
    "shrikhand": f"{_UML}/Shrikhand-Regular.ttf",
    "rubik-mono": f"{_UML}/RubikMonoOne-Regular.ttf",
    "bangers": f"{_UML}/Bangers-Regular.ttf",
    "chewy": f"{_UML}/Chewy-Regular.ttf",
    "cherry-bomb": f"{_UML}/CherryBombOne-Regular.ttf",
    "creepster": f"{_UML}/Creepster-Regular.ttf",
    "monoton": f"{_UML}/Monoton-Regular.ttf",
    "bungee-inline": f"{_UML}/BungeeInline-Regular.ttf",
    "bungee-shade": f"{_UML}/BungeeShade-Regular.ttf",
    "righteous": f"{_UML}/Righteous-Regular.ttf",
    "audiowide": f"{_UML}/Audiowide-Regular.ttf",
    "pixel": f"{_UML}/PressStart2P-Regular.ttf",
    "typewriter": f"{_UML}/SpecialElite-Regular.ttf",
    "pirata": f"{_UML}/PirataOne-Regular.ttf",
    "fraktur": f"{_UML}/UnifrakturMaguntia-Book.ttf",
    "lobster": f"{_UML}/Lobster-Regular.ttf",
    "satisfy": f"{_UML}/Satisfy-Regular.ttf",
    "great-vibes": f"{_UML}/GreatVibes-Regular.ttf",
    "kaushan": f"{_UML}/KaushanScript-Regular.ttf",
    "yellowtail": f"{_UML}/Yellowtail-Regular.ttf",
    "sacramento": f"{_UML}/Sacramento-Regular.ttf",
    "rock-salt": f"{_UML}/RockSalt-Regular.ttf",
    "gloria": f"{_UML}/GloriaHallelujah.ttf",
    "caveat-brush": f"{_UML}/CaveatBrush-Regular.ttf",
    "graffiti": f"{_UML}/SedgwickAveDisplay-Regular.ttf",
    "amatic": f"{_UML}/AmaticSC-Bold.ttf",
    "black-ops": f"{_UML}/BlackOpsOne-Regular.ttf",
    "saira-stencil": f"{_UML}/SairaStencilOne-Regular.ttf",
    "stardos": f"{_UML}/StardosStencil-Bold.ttf",
    "wallpoet": f"{_UML}/Wallpoet-Regular.ttf",
}
# Joined-up, thin or rough letters: cutting them out gives messy, fragile parts.
CUT_UNFRIENDLY = {
    "script", "marker", "creepster", "monoton", "bungee-inline", "bungee-shade", "typewriter", "lobster",
    "satisfy", "great-vibes", "kaushan", "yellowtail", "sacramento", "rock-salt", "gloria", "caveat-brush",
    "graffiti", "amatic",
}
# Stencils: every letter keeps its middle when cut out.
STENCILS = {"stencil", "black-ops", "saira-stencil", "stardos", "wallpoet"}
LINE_GAP = 1.6  # line to line, in cap heights
_cache: dict[str, TTFont] = {}


def _font(name: str) -> TTFont:
    path = FONTS.get(name, FONTS["sans"])
    if path not in _cache:
        _cache[path] = TTFont(path)
    return _cache[path]


def _cap_height(font: TTFont, glyphs, cmap) -> float:
    """Capital height in font units. The font's own number (OS/2 sCapHeight), unless it is missing or more than
    15% away from how tall its 'H' really is: Special Elite says half its real height, Yellowtail says 0. The
    page measures 'H' too (web/src/sketch.ts), so the size box matches."""
    stated = getattr(font["OS/2"], "sCapHeight", 0) or 0
    real = 0.0
    if ord("H") in cmap:
        pen = BoundsPen(glyphs)
        glyphs[cmap[ord("H")]].draw(pen)
        real = pen.bounds[3] if pen.bounds else 0.0
    if real > 0 and not (stated and abs(real / stated - 1) <= 0.15):
        return real
    return stated or font["head"].unitsPerEm * 0.7


def import_text(spec: TextSpec, warnings: ImportWarnings, tol_mm: float = 0.05, budget: PointBudget | None = None) -> list[Item]:
    budget = budget or PointBudget()
    if spec.font not in FONTS:
        warnings.add("That font isn't available, so we used Sans.")
    if spec.op == "cut" and spec.font in CUT_UNFRIENDLY:
        warnings.add("This font comes out messy when cut through. Try Engrave, or a Stencil font.")
    elif spec.op == "cut" and spec.font not in STENCILS:
        warnings.add("Cut-out letters lose their middles (O, A, B…). The Stencil fonts keep them.")
    font = _font(spec.font)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    cap = _cap_height(font, glyphs, cmap)
    k = spec.height_mm / cap  # font units → mm

    lines = [ln for ln in spec.value.replace("\r", "").split("\n")]
    width = lambda ln: sum(hmtx[cmap[ord(ch)]][0] for ch in ln if ord(ch) in cmap)  # noqa: E731
    widest = max(width(ln) for ln in lines)
    items: list[Item] = []
    gi = 0
    for li, line in enumerate(lines):
        pen_x = (widest - width(line)) / 2  # each line centred, like a sign
        base = li * cap * LINE_GAP
        for ch in line:
            gi += 1
            gname = cmap.get(ord(ch))
            if gname is None:
                warnings.add(f"The font has no '{ch}', so it was skipped.")
                continue
            pen = SVGPathPen(glyphs)
            glyphs[gname].draw(pen)
            d = pen.getCommands()
            if d:
                for pts, closed in _flatten(Path(d), tol_mm / k, budget):
                    mm = [((pen_x + x) * k, (base + cap - y) * k) for x, y in pts]  # flip y: font is y-up
                    # one group per letter, so overlapping script letters fill as a union instead of cancelling out
                    items.append(Item("text", spec.op, mm, closed, group=gi))
            pen_x += hmtx[gname][0]
    return items
