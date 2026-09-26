"""DXF → Items using ezdxf. Handles LINE, (LW)POLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE, and INSERT blocks."""
from __future__ import annotations

import io

from ezdxf import disassemble, recover

from . import ImportWarnings, Item, Pt
from .colors import classify_dxf

# $INSUNITS → mm. Unitless (0) is treated as mm, and the student confirms size in the preview.
UNIT_MM = {0: 1.0, 1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 8: 0.0000254, 9: 0.0254}


def import_dxf(data: bytes, warnings: ImportWarnings, tol_mm: float = 0.05) -> list[Item]:
    doc, auditor = recover.read(io.BytesIO(data))
    if auditor.has_errors:
        warnings.add("The DXF had errors. We fixed what we could, so check the preview carefully.")
    units = doc.header.get("$INSUNITS", 0)
    scale = UNIT_MM.get(units)
    if scale is None:
        warnings.add("Unknown DXF units, so we're assuming millimetres.")
        scale = 1.0
    if units == 0:
        warnings.add("The DXF has no units, so we're assuming millimetres. Check the size.")

    msp = doc.modelspace()
    items: list[Item] = []
    raw: list[tuple[str, int, list[Pt], bool]] = []
    for prim in disassemble.to_primitives(disassemble.recursive_decompose(msp)):
        ent = prim.entity
        if ent is None or ent.dxftype() in ("TEXT", "MTEXT", "HATCH", "DIMENSION", "POINT"):
            if ent is not None and ent.dxftype() in ("TEXT", "MTEXT"):
                warnings.add("Text in the DXF was skipped. Explode it to lines first, or use the Text tool.")
            continue
        if prim.path is not None:
            vs = list(prim.path.flattening(distance=tol_mm / scale))
        else:
            vs = list(prim.vertices())
        if len(vs) < 2:
            continue
        pts = [(v.x * scale, v.y * scale) for v in vs]
        closed = abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6
        if closed:
            pts[-1] = pts[0]  # exact, so ordering/hatching treat it as closed
        layer = ent.dxf.get("layer", "0")
        aci = ent.dxf.get("color", 256)
        if aci == 256 and layer in doc.layers:  # BYLAYER
            aci = doc.layers.get(layer).dxf.get("color", 7)
        raw.append((layer, aci, pts, closed))

    if not raw:
        return items
    # DXF is y-up; flip so the top of the drawing sits at y=0.
    max_y = max(y for _, _, pts, _ in raw for _, y in pts)
    for layer, aci, pts, closed in raw:
        kind = classify_dxf(layer, aci)
        flipped = [(x, max_y - y) for x, y in pts]
        items.append(Item(f"dxf:{layer}", kind, flipped, closed))
    return items
