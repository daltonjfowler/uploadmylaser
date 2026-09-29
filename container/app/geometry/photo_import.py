"""Photo (beta): a 1-bit bitmap (binary PBM, P4) → rows of engrave lines.

The browser does the photo work (grey, brightness, contrast, dithering) and sends only black and white
dots. Its size in mm travels in a PBM comment: `# uml-mm-per-px 0.2`. Each run of black dots on a row
becomes one line, rows alternate direction (like hatch.py), and the lines go straight to the engrave
layer: they are the fill, so they are not hatched again.
"""
from __future__ import annotations

import re

from . import ImportProblem, ImportWarnings, Item, PointBudget

PHOTO_KEY = "photo:dots"
MAX_PX = 1500  # per side; the browser stays well under this
MM_PER_PX = (0.05, 1.0)


def _header(data: bytes) -> tuple[int, int, float, int]:
    """(width, height, mm per px, offset of the pixel bytes)."""
    if not data.startswith(b"P4"):
        raise ImportProblem("That photo did not arrive in one piece. Add it again.")
    pos, tokens, mm = 2, [], None
    while len(tokens) < 2:
        m = re.compile(rb"\s*(#[^\n]*\n|\S+)").match(data, pos)
        if not m:
            raise ImportProblem("That photo did not arrive in one piece. Add it again.")
        tok = m.group(1)
        pos = m.end()
        if tok.startswith(b"#"):
            c = re.match(rb"#\s*uml-mm-per-px\s+([0-9.]+)", tok)
            if c:
                mm = float(c.group(1))
        else:
            tokens.append(int(tok))
    pos += 1  # the single whitespace byte before the pixels
    w, h = tokens
    if mm is None or not MM_PER_PX[0] <= mm <= MM_PER_PX[1]:
        raise ImportProblem("That photo has no size. Add it again.")
    if not (0 < w <= MAX_PX and 0 < h <= MAX_PX):
        raise ImportProblem("That photo is too big. Make it smaller.")
    return w, h, mm, pos


def import_photo(data: bytes, warnings: ImportWarnings, budget: PointBudget | None = None) -> list[Item]:
    budget = budget or PointBudget()
    w, h, mm, pos = _header(data)
    stride = (w + 7) // 8
    if len(data) < pos + stride * h:
        raise ImportProblem("That photo did not arrive in one piece. Add it again.")
    items: list[Item] = []
    back = False
    for r in range(h):
        row = data[pos + r * stride: pos + (r + 1) * stride]
        bits = int.from_bytes(row, "big")
        runs: list[tuple[int, int]] = []
        start = -1
        for x in range(w):
            on = (bits >> (stride * 8 - 1 - x)) & 1  # PBM: 1 = black = burn
            if on and start < 0:
                start = x
            elif not on and start >= 0:
                runs.append((start, x))
                start = -1
        if start >= 0:
            runs.append((start, w))
        if not runs:
            continue
        budget.take(2 * len(runs))
        y = (r + 0.5) * mm
        segs = [((a * mm, y), (b * mm, y)) for a, b in runs]
        if back:  # boustrophedon, like hatch.py: every row with dots goes the other way
            segs = [(q, p) for p, q in reversed(segs)]
        back = not back
        items += [Item(PHOTO_KEY, "engrave", [p, q], False, None) for p, q in segs]
    if not items:
        raise ImportProblem("The photo in {part} came out all white. Make it darker or turn up the contrast.")
    return items
