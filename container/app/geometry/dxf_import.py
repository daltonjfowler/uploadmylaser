"""DXF → Items using ezdxf. Handles LINE, (LW)POLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE, SOLID and INSERT blocks.

A DXF that has nothing we can laser raises ImportProblem with what to do in AutoCAD, so a student never gets
a silent blank part. Colours are resolved the way AutoCAD draws them: BYLAYER, BYBLOCK, layer 0 inside a
block, and true colours (24-bit) all count.
"""
from __future__ import annotations

import io
import math
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Optional

from ezdxf import colors as aci_colors
from ezdxf import disassemble, recover
from ezdxf.document import Drawing
from ezdxf.entities import DXFEntity, Insert
from ezdxf.lldxf.tagger import binary_tags_loader
from ezdxf.math import BoundingBox, Matrix44
from ezdxf.protocols import SupportsVirtualEntities, virtual_entities

from . import ImportProblem, ImportWarnings, Item, PointBudget, Pt, TooDetailed
from .colors import classify_dxf, rgb_hex

# $INSUNITS → mm. Unitless (0) is treated as mm, and the student confirms size in the preview.
UNIT_MM = {
    0: 1.0, 1: 25.4, 2: 304.8, 3: 1_609_344.0, 4: 1.0, 5: 10.0, 6: 1000.0, 7: 1_000_000.0, 8: 0.0000254,
    9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100.0, 15: 10_000.0, 16: 100_000.0,
    21: 1200 / 3937 * 1000,  # US survey foot
}
UNIT_NAMES = {1: "inches", 2: "feet", 4: "millimetres", 5: "centimetres", 6: "metres", 10: "yards"}
# What a student may pick on import ("I drew in ..."), as $INSUNITS codes. Architectural is inches.
CHOSEN_UNITS = (1, 2, 4, 5, 6)
# Entities made by expanding block references. Blocks can nest and MINSERT repeats them in a grid, so a
# small file can ask for billions of copies. Real laser drawings need far fewer.
MAX_BLOCK_ENTITIES = 10_000
# A curve bigger than 5 m (and so off any bed) is flattened relative to its size instead of in 0.05 mm
# steps, so a huge-radius circle cannot turn into millions of points.
RELATIVE_TOLERANCE = 1e-5
# Smaller than this (mm) and it was almost certainly drawn in other units than the file says.
TINY_MM = 2.0
# Bigger than this (mm) and no school laser can do it: say which units the file claims.
HUGE_MM = 1500.0

BINARY_SENTINEL = b"AutoCAD Binary DXF"
BYBLOCK, BYLAYER = 0, 256

# What we skip, and what to tell the student. Keys are ezdxf dxftype() names.
TEXT = {"TEXT", "MTEXT", "ATTRIB", "ATTDEF"}
NOTES = {"DIMENSION", "ARC_DIMENSION", "LARGE_RADIAL_DIMENSION", "LEADER", "MLEADER", "MULTILEADER",
         "TOLERANCE", "ACAD_TABLE"}
SOLID_3D = {"3DSOLID", "REGION", "BODY", "SURFACE", "EXTRUDEDSURFACE", "LOFTEDSURFACE", "REVOLVEDSURFACE",
            "SWEPTSURFACE", "PLANESURFACE", "NURBSURFACE"}
PICTURES = {"IMAGE", "WIPEOUT", "OLE2FRAME", "OLEFRAME", "PDFUNDERLAY", "DWFUNDERLAY", "DGNUNDERLAY"}
CONSTRUCTION = {"XLINE", "RAY"}
IGNORED = {"POINT", "VIEWPORT"}

ADVICE = {
    "hidden": "Its lines are on layers that are turned off or frozen. In AutoCAD, turn those layers on and thaw them, then save the DXF again.",
    "text": "Text can't be cut from a DXF. In AutoCAD, use TXTEXP (Express Tools) to turn it into lines, or use the Text tool here.",
    "hatch": "Hatches (fills) are skipped. Draw the outline with a closed polyline instead. Make it blue to engrave it.",
    "solid3d": "3D solids and regions can't be read. In AutoCAD, EXPLODE regions into lines, or use FLATSHOT on a 3D model, then save again.",
    "picture": "Pictures inside a DXF can't be lasered. Trace them with lines, or open the picture as an SVG instead.",
    "notes": "Dimensions and leaders are notes, so they are skipped.",
    "construction": "Construction lines (XLINE and RAY) go on forever, so they are skipped. Draw normal lines instead.",
}
WARN = {
    "hidden": "Lines on layers that are turned off or frozen were skipped.",
    "text": "Text in the DXF was skipped. Explode it to lines first (TXTEXP in AutoCAD), or use the Text tool.",
    "hatch": "Hatches (fills) in the DXF were skipped. Their outlines are used if they are drawn as lines too.",
    "solid3d": "3D solids and regions in the DXF were skipped. EXPLODE them into lines in AutoCAD first.",
    "picture": "Pictures in the DXF were skipped.",
    "notes": "Dimensions and leaders in the DXF were skipped.",
    "construction": "Construction lines (XLINE and RAY) in the DXF were skipped.",
}


@dataclass(frozen=True)
class Style:
    """How AutoCAD would draw an entity: its effective layer, colour and whether that layer is hidden."""
    layer: str
    aci: int
    rgb: Optional[tuple[int, int, int]]
    hidden: bool


def read_doc(data: bytes) -> tuple[Drawing, bool]:
    """(document, had_errors). ASCII in any encoding, or binary. A DWG with a .dxf name gets a clear message."""
    head = data[:32].lstrip(b"\xef\xbb\xbf")
    if head.startswith(BINARY_SENTINEL):
        return Drawing.load(binary_tags_loader(data)), False
    if head[:2] == b"AC" and head[2:6].isdigit():  # DWG files start with their version, e.g. AC1027
        raise ImportProblem("{part} is a DWG file, not a DXF. In AutoCAD, use Save As and pick a DXF type (AutoCAD 2013 DXF is fine), then open that file.")
    doc, auditor = recover.read(io.BytesIO(data))
    return doc, auditor.has_errors


def _layer_style(doc: Drawing, name: str) -> tuple[int, Optional[tuple[int, int, int]], bool, bool]:
    """(aci, rgb, off, frozen) of a layer. A negative colour number is how DXF says a layer is off."""
    if name not in doc.layers:
        return 7, None, False, False
    layer = doc.layers.get(name)
    color = layer.dxf.get("color", 7)
    rgb = layer.rgb if layer.dxf.hasattr("true_color") else None
    return abs(color) or 7, rgb, color < 0, layer.is_frozen()


def _style(doc: Drawing, entity: DXFEntity, parent: Optional[Style]) -> Style:
    layer = entity.dxf.get("layer", "0")
    if parent is not None and layer == "0":
        layer = parent.layer  # layer 0 inside a block takes the block reference's layer
    l_aci, l_rgb, off, frozen = _layer_style(doc, layer)
    aci = entity.dxf.get("color", BYLAYER)
    rgb = entity.rgb if entity.dxf.hasattr("true_color") else None
    if rgb is None and aci == BYBLOCK:
        aci, rgb = (parent.aci, parent.rgb) if parent is not None else (7, None)
    elif rgb is None and (aci == BYLAYER or aci < 0 or aci > 255):
        aci, rgb = l_aci, l_rgb
    hidden = off or frozen or (parent is not None and parent.hidden)
    return Style(layer, aci, rgb, hidden)


def _decompose(doc: Drawing, entities: Iterable[DXFEntity], made: list[int], parent: Optional[Style] = None,
               nested: bool = False, m: Optional[Matrix44] = None) -> Iterator[tuple[DXFEntity, Style, Optional[Matrix44]]]:
    """Every drawable entity with the matrix that takes it from its block to the drawing (None: already there),
    counting every entity a block reference expands into and carrying the block reference's layer and colour
    down. Plain entities in the drawing itself are already limited by the upload size and the point budget.
    Dimensions are not expanded: their lines are notes, not parts.

    Block references are expanded with one exact matrix per level, multiplied together, instead of ezdxf's
    virtual entities: those approximate a block inside a rotated, unevenly scaled block (a skew), which put
    doors and windows several mm away from where AutoCAD draws them (Dalton, 2026-10-05)."""
    for entity in entities:
        if nested:
            made[0] += 1
            if made[0] > MAX_BLOCK_ENTITIES:
                raise TooDetailed()
        style = _style(doc, entity, parent)
        kind = entity.dxftype()
        if isinstance(entity, Insert):
            if entity.mcount > MAX_BLOCK_ENTITIES:  # rows x columns, before making any of them
                raise TooDetailed()
            copies = entity.multi_insert() if entity.mcount > 1 else [entity]
            yield from ((a, style, m) for a in entity.attribs)  # in the parent's coordinates
            for ref in copies:
                if entity.mcount > 1:  # every copy counts, even of an empty block
                    made[0] += 1
                    if made[0] > MAX_BLOCK_ENTITIES:
                        raise TooDetailed()
                block = ref.block()
                if block is None:
                    continue
                inner = ref.matrix44() if m is None else ref.matrix44() @ m
                yield from _decompose(doc, block, made, style, True, inner)
        elif kind not in NOTES and isinstance(entity, SupportsVirtualEntities):
            yield from _decompose(doc, virtual_entities(entity), made, style, True, m)
        else:
            yield entity, style, m


def _skip_reason(kind: str) -> Optional[str]:
    if kind in TEXT:
        return "text"
    if kind == "HATCH" or kind == "MPOLYGON":
        return "hatch"
    if kind in NOTES:
        return "notes"
    if kind in SOLID_3D:
        return "solid3d"
    if kind in PICTURES:
        return "picture"
    if kind in CONSTRUCTION:
        return "construction"
    return None


def _classify(style: Style) -> tuple[str, Optional[str]]:
    """(key, kind). Every colour on a layer gets its own key, so choosing for one colour never changes the
    others on the same layer (the page lists each one to change)."""
    if style.rgb is not None:
        rgb = tuple(style.rgb)
    elif style.aci == 7:  # black on paper, white on a dark screen
        rgb = (0, 0, 0)
    else:
        rgb = tuple(aci_colors.aci2rgb(style.aci))
    kind = classify_dxf(style.layer, rgb)
    return f"dxf:{style.layer}|{rgb_hex(*rgb)}", kind


def _paper_entities(doc: Drawing) -> list[DXFEntity]:
    return [e for layout in doc.layouts if layout.is_any_paperspace for e in layout if e.dxftype() != "VIEWPORT"]


def import_dxf(data: bytes, warnings: ImportWarnings, tol_mm: float = 0.05, budget: PointBudget | None = None,
               units: int | None = None) -> list[Item]:
    """`units`: the $INSUNITS code the student says they drew in, ahead of what the file claims."""
    budget = budget or PointBudget()
    doc, had_errors = read_doc(data)
    if had_errors:
        warnings.add("The DXF had errors. We fixed what we could, so check the preview carefully.")
    chosen = units in CHOSEN_UNITS
    if not chosen:
        units = doc.header.get("$INSUNITS", 0)
    scale = UNIT_MM.get(units)
    if scale is None:
        warnings.add("Unknown DXF units, so we're assuming millimetres.")
        scale = 1.0
    if units == 0:
        warnings.add("The DXF has no units, so we're assuming millimetres. Check the size.")

    skipped: set[str] = set()
    raw = _collect(doc, doc.modelspace(), scale, tol_mm, budget, skipped)
    if not raw:
        paper = _paper_entities(doc)
        if paper:
            raw = _collect(doc, paper, scale, tol_mm, budget, skipped)
            if raw:
                warnings.add("This DXF was drawn on a layout tab (paper space), so we used that. Next time, draw on the Model tab.")
    if not raw:
        reasons = [ADVICE[r] for r in ADVICE if r in skipped]
        if not reasons:
            reasons = ["There are no lines in it. In AutoCAD, draw on the Model tab, then Save As DXF again."]
        raise ImportProblem("Nothing to laser in {part}. " + " ".join(reasons))
    for r in WARN:
        if r in skipped:
            warnings.add(WARN[r])

    xs = [x for _, _, pts, _ in raw for x, _ in pts]
    ys = [y for _, _, pts, _ in raw for _, y in pts]
    size = max(max(xs) - min(xs), max(ys) - min(ys))
    if chosen and size < TINY_MM:
        warnings.add(f"This DXF is only {size:.2g} mm across in {UNIT_NAMES[units]}. Select it and check Drawn in.")
    elif chosen and size > HUGE_MM:
        warnings.add(f"This DXF is {size:.0f} mm across in {UNIT_NAMES[units]}. If you drew in other units, select it "
                     "and change Drawn in.")
    elif size < TINY_MM:
        warnings.add(f"This DXF is only {size:.2g} mm across, so it was probably drawn in other units. In AutoCAD, "
                     "type UNITS and set Insertion scale to the units you drew in, then save again.")
    elif size > HUGE_MM and units in UNIT_NAMES:
        warnings.add(f"This DXF is {size:.0f} mm across because it says it is in {UNIT_NAMES[units]}. If you drew in "
                     "millimetres, type UNITS in AutoCAD, set Insertion scale to Millimeters, then save again.")

    # DXF is y-up; flip so the top of the drawing sits at y=0.
    max_y = max(ys)
    return [Item(key, kind, [(x, max_y - y) for x, y in pts], closed) for key, kind, pts, closed in raw]


def _collect(doc: Drawing, entities: Iterable[DXFEntity], scale: float, tol_mm: float, budget: PointBudget,
             skipped: set[str]) -> list[tuple[str, Optional[str], list[Pt], bool]]:
    raw: list[tuple[str, Optional[str], list[Pt], bool]] = []
    for ent, style, m in _decompose(doc, entities, [0]):
        kind = ent.dxftype()
        reason = _skip_reason(kind)
        if kind in IGNORED:
            continue
        if style.hidden:
            if reason is None:
                skipped.add("hidden")
            continue
        if reason is not None:
            skipped.add(reason)
            continue
        for prim in disassemble.to_primitives([ent]):
            if prim.path is not None:
                path = prim.path if m is None else prim.path.transform(m)
                box = BoundingBox(path.control_vertices())
                size = max(box.size.x, box.size.y) if box.has_data else 0.0
                if not math.isfinite(size):
                    raise ValueError("DXF coordinates are not finite")
                vs = list(path.flattening(distance=max(tol_mm / scale, size * RELATIVE_TOLERANCE)))
            else:
                vs = list(prim.vertices()) if m is None else list(m.transform_vertices(prim.vertices()))
            budget.take(len(vs))
            if len(vs) < 2:
                continue
            pts = [(v.x * scale, v.y * scale) for v in vs]
            if not all(math.isfinite(c) for p in pts for c in p):
                raise ValueError("DXF coordinates are not finite")
            closed = abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6
            if closed:
                pts[-1] = pts[0]  # exact, so ordering/hatching treat it as closed
            key, op = _classify(style)
            raw.append((key, op, pts, closed))
    return raw
