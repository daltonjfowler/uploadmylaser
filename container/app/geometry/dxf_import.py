"""DXF → Items using ezdxf. Handles LINE, (LW)POLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE, and INSERT blocks."""
from __future__ import annotations

import io
import math
from collections.abc import Iterable, Iterator

from ezdxf import disassemble, recover
from ezdxf.entities import DXFEntity, Insert
from ezdxf.math import BoundingBox
from ezdxf.protocols import SupportsVirtualEntities, virtual_entities

from . import ImportWarnings, Item, PointBudget, Pt, TooDetailed
from .colors import classify_dxf

# $INSUNITS → mm. Unitless (0) is treated as mm, and the student confirms size in the preview.
UNIT_MM = {0: 1.0, 1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 8: 0.0000254, 9: 0.0254}
# Entities made by expanding block references. Blocks can nest and MINSERT repeats them in a grid, so a
# small file can ask for billions of copies. Real laser drawings need far fewer.
MAX_BLOCK_ENTITIES = 10_000
# A curve bigger than 5 m (and so off any bed) is flattened relative to its size instead of in 0.05 mm
# steps, so a huge-radius circle cannot turn into millions of points.
RELATIVE_TOLERANCE = 1e-5


def _decompose(entities: Iterable[DXFEntity], made: list[int], nested: bool = False) -> Iterator[DXFEntity]:
    """ezdxf's recursive_decompose, counting every entity a block reference expands into. Plain entities
    in the drawing itself are already limited by the upload size and the point budget."""
    for entity in entities:
        if nested:
            made[0] += 1
            if made[0] > MAX_BLOCK_ENTITIES:
                raise TooDetailed()
        if isinstance(entity, Insert):
            if entity.mcount > 1:
                yield from _decompose(entity.multi_insert(), made, True)
            else:
                yield from entity.attribs
                yield from _decompose(virtual_entities(entity), made, True)
        elif isinstance(entity, SupportsVirtualEntities):
            yield from _decompose(virtual_entities(entity), made, True)
        else:
            yield entity


def import_dxf(data: bytes, warnings: ImportWarnings, tol_mm: float = 0.05, budget: PointBudget | None = None) -> list[Item]:
    budget = budget or PointBudget()
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
    for prim in disassemble.to_primitives(_decompose(msp, [0])):
        ent = prim.entity
        if ent is None or ent.dxftype() in ("TEXT", "MTEXT", "HATCH", "DIMENSION", "POINT"):
            if ent is not None and ent.dxftype() in ("TEXT", "MTEXT"):
                warnings.add("Text in the DXF was skipped. Explode it to lines first, or use the Text tool.")
            continue
        if prim.path is not None:
            box = BoundingBox(prim.path.control_vertices())
            size = max(box.size.x, box.size.y) if box.has_data else 0.0
            if not math.isfinite(size):
                raise ValueError("DXF coordinates are not finite")
            vs = list(prim.path.flattening(distance=max(tol_mm / scale, size * RELATIVE_TOLERANCE)))
        else:
            vs = list(prim.vertices())
        budget.take(len(vs))
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
