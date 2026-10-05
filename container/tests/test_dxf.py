"""AutoCAD DXF import (2013 format, AC1027, unless noted). Bug from school, 2026-09-28: an "AutoCAD 2013 DXF"
came in as a blank part showing only its file name. A DXF must either show its lines or say what to do in
AutoCAD, never a silent blank part."""
import base64
import io
import math

import ezdxf
import pytest

from app.geometry import ImportWarnings
from app.geometry.dxf_import import import_dxf
from app.models import ContainerJob, FilePart, MachineConfig, Material, OpSettings, ProcessRequest
from app.pipeline import process

MAT = Material(
    id="ply3", name="3mm plywood", thickness_mm=3,
    ops={
        "cut": OpSettings(speed_mm_s=15, power_min_pct=55, power_max_pct=65),
        "score": OpSettings(speed_mm_s=150, power_min_pct=15, power_max_pct=20),
        "engrave": OpSettings(speed_mm_s=250, power_min_pct=18, power_max_pct=25, hatch_mm=0.2),
    },
)
M = MachineConfig(job_origin_mode="absolute")


def new(units: int = 4):
    doc = ezdxf.new("R2013")
    doc.header["$INSUNITS"] = units
    return doc


def dxf_bytes(doc, fmt: str = "asc") -> bytes:
    if fmt == "bin":
        b = io.BytesIO()
        doc.write(b, fmt="bin")
        return b.getvalue()
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode()


def run(data: bytes, **req):
    r = ProcessRequest(material_id="ply3", parts=[FilePart(file_index=0, file_type="dxf", x_mm=200, y_mm=10)], **req)
    return process(ContainerJob(request=r, material=MAT, machine=M, files_b64=[base64.b64encode(data).decode()]))


def items(doc, fmt: str = "asc"):
    w = ImportWarnings()
    return import_dxf(dxf_bytes(doc, fmt), w), w


def size(its):
    xs = [x for it in its for x, _ in it.pts]
    ys = [y for it in its for _, y in it.pts]
    return round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2)


def kinds(its):
    return sorted({(it.key, it.kind) for it in its}, key=str)


# ---------- entity types AutoCAD writes ----------

@pytest.mark.parametrize("draw, want", [
    (lambda m: m.add_lwpolyline([(0, 0), (50, 0), (50, 30), (0, 30)], close=True), (50, 30)),
    # a bulge of 1 is a half circle: the bottom edge dips 25 below y = 0
    (lambda m: m.add_lwpolyline([(0, 0, 0, 0, 1), (50, 0, 0, 0, 0), (50, 30), (0, 30)], format="xyseb", close=True), (50, 55)),
    (lambda m: m.add_polyline2d([(0, 0), (50, 0), (50, 30)], close=True), (50, 30)),
    (lambda m: m.add_polyline3d([(0, 0, 0), (50, 0, 5), (50, 30, 0)], close=True), (50, 30)),
    (lambda m: (m.add_line((0, 0), (40, 0)), m.add_arc((20, 0), 20, 0, 180), m.add_circle((20, 5), 3)), (40, 20)),
    (lambda m: m.add_ellipse((0, 0), (30, 0, 0), 0.5), (60, 30)),
    (lambda m: m.add_spline([(0, 0), (10, 10), (20, 0), (30, 10)]), (30, 10.26)),
    (lambda m: m.add_open_spline([(0, 0), (10, 10), (20, 0), (30, 10)]), (30, 10)),
    # MIRROR in AutoCAD writes circles with a flipped extrusion
    (lambda m: m.add_circle((10, 0), 5, dxfattribs={"extrusion": (0, 0, -1)}), (10, 10)),
    (lambda m: m.add_circle((1e6, 2e6), 10), (20, 20)),  # far from the origin
])
def test_autocad_2013_entities_import(draw, want):
    doc = new()
    draw(doc.modelspace())
    its, w = items(doc)
    assert size(its) == want
    assert all(it.kind == "cut" for it in its)
    res = run(dxf_bytes(doc))
    assert res.errors == [] and res.rd, res.errors


def test_blocks_nested_scaled_rotated_and_mirrored():
    doc = new()
    peg = doc.blocks.new("PEG")
    peg.add_circle((0, 0), 5)
    row = doc.blocks.new("ROW")
    row.add_blockref("PEG", (0, 0))
    row.add_blockref("PEG", (20, 0), dxfattribs={"xscale": 2, "yscale": 2})
    doc.modelspace().add_blockref("ROW", (0, 0), dxfattribs={"xscale": -1, "rotation": 90})
    its, _ = items(doc)
    # r 5 at x 0 and r 10 at x 20: 35 x 20 in the block, turned 90 degrees
    assert len(its) == 2 and size(its) == (20, 35)


def test_binary_dxf_imports():
    doc = new()
    doc.modelspace().add_circle((0, 0), 10)
    its, _ = items(doc, "bin")
    assert size(its) == (20, 20)
    assert run(dxf_bytes(doc, "bin")).rd


def test_crlf_and_utf8_bom():
    doc = new()
    doc.modelspace().add_circle((0, 0), 10)
    data = b"\xef\xbb\xbf" + dxf_bytes(doc).replace(b"\n", b"\r\n")
    assert run(data).rd


def test_dwg_renamed_to_dxf_says_so():
    res = run(b"AC1027\x00\x00\x00\x00\x00\x06\x01" + bytes(200))
    assert len(res.errors) == 1 and "DWG" in res.errors[0] and "Save As" in res.errors[0]


# ---------- colours: resolved the way AutoCAD draws them ----------

def test_true_colours_count():
    doc = new()
    m = doc.modelspace()
    m.add_circle((0, 0), 10).rgb = (255, 0, 0)  # entity true colour red: mark, not cut
    doc.layers.add("L").rgb = (0, 0, 255)       # layer true colour blue: engrave
    m.add_circle((50, 0), 10, dxfattribs={"layer": "L"})
    its, _ = items(doc)
    assert kinds(its) == [("dxf:0|#ff0000", "score"), ("dxf:L|#0000ff", "engrave")]


def test_block_on_red_layer_marks_its_layer_0_lines():
    doc = new()
    doc.blocks.new("B").add_circle((0, 0), 5)
    doc.layers.add("RED", color=1)
    doc.modelspace().add_blockref("B", (10, 10), dxfattribs={"layer": "RED"})
    its, _ = items(doc)
    assert kinds(its) == [("dxf:RED|#ff0000", "score")]


def test_byblock_colour_takes_the_block_references_colour():
    doc = new()
    doc.blocks.new("B").add_circle((0, 0), 5, dxfattribs={"color": 0})  # BYBLOCK
    doc.modelspace().add_blockref("B", (10, 10), dxfattribs={"color": 5})
    its, _ = items(doc)
    assert kinds(its) == [("dxf:0|#0000ff", "engrave")]


def test_near_colours_follow_the_svg_rules():
    doc = new()
    m = doc.modelspace()
    for i, aci in enumerate((250, 10, 150)):  # near black, red, blue
        m.add_circle((i * 30, 0), 10, dxfattribs={"color": aci})
    assert sorted(it.kind for it in items(doc)[0]) == ["cut", "engrave", "score"]


def test_unknown_colour_is_drawn_and_only_it_is_asked_about():
    doc = new()
    m = doc.modelspace()
    m.add_circle((0, 0), 10)                          # black: cut
    m.add_circle((50, 0), 10, dxfattribs={"color": 3})  # green, same layer 0
    res = run(dxf_bytes(doc))
    assert res.unknown_colors == ["dxf:0|#00ff00"]
    # the part is not blank: its box covers both circles and the green one is sent to draw in grey
    assert res.part_boxes == [(130, 10, 200, 30)]
    assert [u.part for u in res.unassigned] == [0] and len(res.unassigned[0].paths) == 1
    # choosing for the green circle leaves the black one cutting
    res2 = run(dxf_bytes(doc), color_map={"dxf:0|#00ff00": "score"})
    assert res2.errors == [] and [p.kind for p in res2.preview] == ["score", "cut"]


def test_all_unknown_colours_still_give_the_part_a_box():
    doc = new()
    doc.layers.add("Outline", color=4)  # cyan: a typical AutoCAD class layer
    doc.modelspace().add_lwpolyline([(0, 0), (40, 0), (40, 20), (0, 20)], close=True, dxfattribs={"layer": "Outline"})
    res = run(dxf_bytes(doc))
    assert res.errors == ["Choose what each colour should do."]
    assert res.unknown_colors == ["dxf:Outline|#00ffff"]
    assert res.part_boxes == [(160, 10, 200, 30)] and res.unassigned


# ---------- what AutoCAD hides, and where it was drawn ----------

def test_paper_space_only_drawing_is_used_with_a_note():
    doc = new()
    doc.paperspace().add_lwpolyline([(0, 0), (50, 0), (50, 30)], close=True)
    res = run(dxf_bytes(doc))
    assert res.errors == [] and res.rd
    assert any("layout tab" in w for w in res.warnings)


def test_off_and_frozen_layers_are_skipped():
    doc = new()
    doc.layers.add("OFF").off()
    doc.layers.add("FROZEN").freeze()
    m = doc.modelspace()
    m.add_circle((0, 0), 10, dxfattribs={"layer": "OFF"})
    m.add_circle((0, 0), 10, dxfattribs={"layer": "FROZEN"})
    m.add_circle((50, 0), 5)
    its, w = items(doc)
    assert size(its) == (10, 10)
    assert any("turned off or frozen" in x for x in w)


def test_dimensions_are_notes_not_cuts():
    doc = new()
    m = doc.modelspace()
    m.add_circle((0, 0), 10)
    m.add_linear_dim(base=(0, 20), p1=(-10, 0), p2=(10, 0)).render()
    res = run(dxf_bytes(doc))
    assert res.errors == [] and res.unknown_colors == []
    assert res.part_boxes == [(180, 10, 200, 30)]  # just the circle
    assert any("Dimensions" in w for w in res.warnings)


# ---------- nothing to laser: say what to do, never a blank part ----------

def _text(m):
    m.add_text("HELLO")
    m.add_mtext("WORLD")


def _hatch(m):
    m.add_hatch(color=5).paths.add_polyline_path([(0, 0), (10, 0), (10, 10)])


def _frozen(m):
    m.doc.layers.add("F").freeze()
    m.add_circle((0, 0), 10, dxfattribs={"layer": "F"})


@pytest.mark.parametrize("draw, advice", [
    (lambda m: None, "draw on the Model tab"),
    (_text, "TXTEXP"),
    (_hatch, "closed polyline"),
    (lambda m: m.add_xline((0, 0), (1, 1)), "XLINE"),
    (_frozen, "turn those layers on"),
])
def test_nothing_to_laser_says_what_to_do(draw, advice):
    doc = new()
    draw(doc.modelspace())
    res = run(dxf_bytes(doc))
    assert len(res.errors) == 1, res.errors
    assert res.errors[0].startswith('Nothing to laser in "part 1".') and advice in res.errors[0], res.errors[0]


# ---------- units ----------

def test_inches_and_every_common_unit():
    for units, mm in ((1, 25.4), (2, 304.8), (5, 10), (6, 1000), (13, 0.001), (14, 100)):
        doc = new(units)
        doc.modelspace().add_line((0, 0), (1, 0))
        its, w = items(doc)
        assert abs(its[0].pts[1][0] - its[0].pts[0][0] - mm) < 1e-9, units
        assert "Unknown DXF units, so we're assuming millimetres." not in w


def test_tiny_drawing_warns_about_units():
    doc = new(0)  # unitless, drawn in metres: 20 mm came in as 0.02 mm
    doc.modelspace().add_circle((0, 0), 0.01)
    res = run(dxf_bytes(doc))
    assert res.rd and any("Insertion scale" in w for w in res.warnings)


def test_inch_drawing_meant_as_mm_warns():
    doc = new(1)  # AutoCAD's default template is in inches; a student typed millimetres
    doc.modelspace().add_lwpolyline([(0, 0), (100, 0), (100, 50), (0, 50)], close=True)
    res = run(dxf_bytes(doc))
    assert any("says it is in inches" in w for w in res.warnings)


def test_every_file_colour_is_listed_and_can_change_again():
    doc = new()
    m = doc.modelspace()
    m.add_circle((0, 0), 10)                            # black: cut
    m.add_circle((50, 0), 10, dxfattribs={"color": 3})  # green: unknown
    res = run(dxf_bytes(doc))
    assert [(c.part, c.key, c.kind) for c in res.part_colors] == [(0, "dxf:0|#000000", "cut"), (0, "dxf:0|#00ff00", None)]
    # a choice sits on the file part itself, and a known colour can be changed too
    data = base64.b64encode(dxf_bytes(doc)).decode()
    def with_map(cm):
        part = FilePart(file_index=0, file_type="dxf", x_mm=200, y_mm=10, color_map=cm)
        r = ProcessRequest(material_id="ply3", parts=[part])
        return process(ContainerJob(request=r, material=MAT, machine=M, files_b64=[data]))
    res2 = with_map({"dxf:0|#00ff00": "cut"})
    assert res2.errors == [] and [p.kind for p in res2.preview] == ["cut"]
    res3 = with_map({"dxf:0|#00ff00": "engrave", "dxf:0|#000000": "score"})
    assert res3.errors == [] and [p.kind for p in res3.preview] == ["engrave", "score"]
    # black and red on one layer are two colours: changing one leaves the other
    m.add_circle((100, 0), 10, dxfattribs={"color": 1})
    data = base64.b64encode(dxf_bytes(doc)).decode()
    res4 = with_map({"dxf:0|#00ff00": "cut", "dxf:0|#000000": "engrave"})
    assert res4.errors == [] and [p.kind for p in res4.preview] == ["engrave", "score", "cut"]
    # the listed kind stays the file's own, so the page can offer "back to how the file had it"
    assert [c.kind for c in res3.part_colors] == ["cut", None]


def test_file_choice_does_not_touch_other_parts():
    doc = new()
    doc.modelspace().add_circle((0, 0), 10)  # black: cut
    data = base64.b64encode(dxf_bytes(doc)).decode()
    parts = [
        FilePart(file_index=0, file_type="dxf", x_mm=200, y_mm=10, color_map={"dxf:0|#000000": "score"}),
        FilePart(file_index=0, file_type="dxf", x_mm=400, y_mm=10),
    ]
    res = process(ContainerJob(request=ProcessRequest(material_id="ply3", parts=parts), material=MAT, machine=M, files_b64=[data]))
    assert res.errors == []
    assert sorted((p.part, p.kind) for p in res.preview) == [(0, "score"), (1, "cut")]


def test_student_units_win_over_the_file():
    """Dalton 2026-10-04: ask which units the drawing was made in. Inches makes a 10-unit square 254 mm."""
    doc = new(units=0)  # the file says nothing
    doc.modelspace().add_lwpolyline([(0, 0), (10, 0), (10, 10), (0, 10)], close=True)
    w = ImportWarnings()
    items = import_dxf(dxf_bytes(doc), w, units=1)
    xs = [x for it in items for x, _ in it.pts]
    assert abs(max(xs) - min(xs) - 254) < 0.01
    assert not any("no units" in m for m in w)
    w2 = ImportWarnings()
    items = import_dxf(dxf_bytes(doc), w2, units=4)  # mm
    assert abs(max(x for it in items for x, _ in it.pts) - 10) < 0.01


def test_file_units_used_when_nothing_chosen():
    doc = new(units=1)
    doc.modelspace().add_lwpolyline([(0, 0), (2, 0), (2, 2), (0, 2)], close=True)
    items = import_dxf(dxf_bytes(doc), ImportWarnings())
    assert abs(max(x for it in items for x, _ in it.pts) - 50.8) < 0.01


def test_block_inside_a_rotated_unevenly_scaled_block_is_exact():
    """Dalton 2026-10-05, "objects moved": ezdxf's virtual entities approximated this skew by 5-9 mm."""
    doc = new()
    part = doc.blocks.new("PART", base_point=(10, 5))
    part.add_lwpolyline([(0, 0), (40, 0), (40, 20), (0, 20)], close=True)
    doc.blocks.new("OUTER").add_blockref("PART", (100, 0), dxfattribs={"rotation": 30, "xscale": 2, "yscale": 1.5})
    doc.modelspace().add_blockref("OUTER", (500, 200), dxfattribs={"rotation": 45, "xscale": 1.5, "yscale": 0.8})
    items = import_dxf(dxf_bytes(doc), ImportWarnings())
    xs = [x for it in items for x, _ in it.pts]
    ys = [y for it in items for _, y in it.pts]
    assert abs((max(xs) - min(xs)) - (651.86 - 570.40)) < 0.02  # the true corners, worked out by hand
    assert abs((max(ys) - min(ys)) - (378.45 - 281.13)) < 0.02


def test_scaled_up_circles_stay_round():
    """Dalton 2026-10-05, "boxy": curves were flattened before the part was scaled, so 20x scale meant 20x
    bigger steps. Every chord's midpoint must stay within 0.05 mm of the true circle on the bed."""
    doc = new()
    doc.modelspace().add_circle((0, 0), 2)
    job = ContainerJob(request=ProcessRequest(material_id="ply3", parts=[FilePart(file_index=0, file_type="dxf", x_mm=200, y_mm=10, scale=20)]),
                       material=MAT, machine=M, files_b64=[base64.b64encode(dxf_bytes(doc)).decode()])
    res = process(job)
    pts = [p for layer in res.preview for path in layer.paths for p in path]
    cx = (max(x for x, _ in pts) + min(x for x, _ in pts)) / 2
    cy = (max(y for _, y in pts) + min(y for _, y in pts)) / 2
    worst = max(40 - math.hypot((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy) for a, b in zip(pts, pts[1:]))
    assert worst < 0.06, worst
