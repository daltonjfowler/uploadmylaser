import base64

import pytest
from pydantic import ValidationError

from app.models import ContainerJob, FilePart, MachineConfig, Material, OpSettings, ProcessRequest, TextPart, TextSpec
from app.pipeline import process
from app.geometry.order import order_cuts
from app.geometry.hatch import hatch

MAT = Material(
    id="ply3", name="3mm plywood", thickness_mm=3,
    ops={
        "cut": OpSettings(speed_mm_s=15, power_min_pct=55, power_max_pct=65),
        "score": OpSettings(speed_mm_s=150, power_min_pct=15, power_max_pct=20),
        "engrave": OpSettings(speed_mm_s=250, power_min_pct=18, power_max_pct=25, hatch_mm=0.2),
    },
)
M = MachineConfig(job_origin_mode="absolute")  # most tests check bed placement
M_REL = MachineConfig()                           # default: job anchored at the laser head

# black = cut, red = mark ("score" internally), blue = engrave
SVG = b"""<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">
  <rect x="0" y="0" width="50" height="50" fill="none" stroke="#000000"/>
  <circle cx="25" cy="25" r="5" fill="none" stroke="black"/>
  <rect x="10" y="10" width="10" height="10" fill="#0000ff"/>
  <line x1="30" y1="40" x2="45" y2="40" stroke="red"/>
</svg>"""


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def job(svg: bytes = SVG, x_mm: float = 70, y_mm: float = 20, **req) -> ContainerJob:
    """One SVG part. (x_mm, y_mm) is where its top-right corner goes, so the 50 mm SVG spans x 20..70."""
    r = ProcessRequest(material_id="ply3", parts=[FilePart(file_index=0, file_type="svg", x_mm=x_mm, y_mm=y_mm)], **req)
    return ContainerJob(request=r, material=MAT, machine=M, files_b64=[b64(svg)])


def multi(*svgs: bytes, at: list[tuple[float, float]], machine: MachineConfig = M, **req) -> ContainerJob:
    parts = [FilePart(file_index=i, file_type="svg", x_mm=x, y_mm=y) for i, (x, y) in enumerate(at)]
    r = ProcessRequest(material_id="ply3", parts=parts, **req)
    return ContainerJob(request=r, material=MAT, machine=machine, files_b64=[b64(s) for s in svgs])


def square(size: float, fill: str = "#0000ff", stroke: str = "none") -> bytes:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{size}mm" height="{size}mm" viewBox="0 0 {size} {size}">
      <rect x="0" y="0" width="{size}" height="{size}" fill="{fill}" stroke="{stroke}"/></svg>""".encode()


def test_svg_square_with_hole_engrave_and_score():
    res = process(job())
    assert res.errors == [], res.errors
    assert [p.kind for p in res.preview] == ["engrave", "score", "cut"]
    assert res.rd and res.frame_rd
    x0, y0, x1, y1 = res.bbox_mm
    assert abs(x0 - 20) < 0.01 and abs(x1 - 70) < 0.01  # 50mm wide, units honoured
    cut = next(p for p in res.preview if p.kind == "cut")
    assert len(cut.paths) == 2
    # inner circle is cut before the outer square
    assert max(x for x, _ in cut.paths[0]) < 60


def test_relative_mode_anchors_top_right_at_head():
    from app.ruida.decoder import dec35, decode_rd
    j = job()
    j.machine = M_REL
    res = process(j)
    assert res.errors == [], res.errors
    assert res.bbox_mm == (20, 20, 70, 70)  # stays where the student put it; the UI shows the head at its top-right
    moved = job(x_mm=500, y_mm=300)
    moved.machine = M_REL
    assert process(moved).rd == res.rd  # position on the workspace doesn't change the job itself
    cmds = {c.name: c.data for c in decode_rd(base64.b64decode(res.rd), 0x88)}
    assert "REF_POINT_1" in cmds
    tl = cmds["PROCESS_TOP_LEFT"]
    assert (dec35(tl[:5]), dec35(tl[5:10])) == (0, 0)
    br = cmds["PROCESS_BOTTOM_RIGHT"]
    assert abs(dec35(br[:5]) - 50_000) <= 1 and abs(dec35(br[5:10]) - 50_000) <= 1  # 50 mm design


def test_black_stroke_and_fill_is_cut_once():
    svg = b"""<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <rect x="0" y="0" width="20" height="20" fill="black" stroke="black"/></svg>"""
    res = process(job(svg))
    assert [p.kind for p in res.preview] == ["cut"]
    assert len(res.preview[0].paths) == 1


def test_default_fill_is_not_treated_as_cut():
    svg = b"""<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" stroke="red"/></svg>"""  # no fill attribute
    res = process(job(svg))
    assert [p.kind for p in res.preview] == ["score"]


def test_unknown_colour_asks_student():
    svg = SVG.replace(b'stroke="red"', b'stroke="#00ff00"')
    res = process(job(svg))
    assert res.unknown_colors == ["stroke:#00ff00"]
    assert res.rd is None
    res2 = process(job(svg, color_map={"stroke:#00ff00": "ignore"}))
    assert res2.errors == [] and res2.rd


def test_off_bed_is_an_error():
    r = job()
    r.request.parts[0].x_mm = 950
    res = process(r)
    assert res.rd is None and any("edge" in e for e in res.errors)


def test_garbage_file_is_a_friendly_error():
    res = process(job(b"not an svg"))
    assert res.errors == ['We couldn\'t read "part 1" (SVG). Try exporting it again.'] and res.rd is None


def test_student_power_choice_is_clamped_to_teacher_range():
    from app.pipeline import apply_power_choice
    s = OpSettings(speed_mm_s=200, power_min_pct=15, power_max_pct=15, student_min_pct=15, student_max_pct=35)
    assert apply_power_choice(s, None).power_max_pct == 15
    assert apply_power_choice(s, 25).power_max_pct == 25
    assert apply_power_choice(s, 90).power_max_pct == 35
    assert apply_power_choice(s, 1).power_min_pct == 15
    fixed = OpSettings(speed_mm_s=20, power_min_pct=55, power_max_pct=55)
    assert apply_power_choice(fixed, 90).power_max_pct == 55  # no range, so the choice is ignored


def test_order_cuts_inner_first():
    outer = [(0, 0), (100, 0), (100, 100), (0, 100), (0, 0)]
    inner = [(40, 40), (60, 40), (60, 60), (40, 60), (40, 40)]
    assert order_cuts([outer, inner])[0] == inner


def test_hatch_leaves_holes_empty():
    outer = [(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]
    hole = [(4, 4), (6, 4), (6, 6), (4, 6), (4, 4)]
    lines = hatch([outer, hole], 1.0)
    for ln in lines:
        (xa, y), (xb, _) = ln[0], ln[-1]
        if 4 < y < 6:
            lo, hi = sorted((xa, xb))
            assert hi <= 4.001 or lo >= 5.999


def test_overlapping_letters_stay_filled():
    """Script letters overlap. As separate groups they union, so the overlap is engraved, not left blank."""
    from app.geometry.hatch import region
    a = [(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]
    b = [(5, 0), (15, 0), (15, 10), (5, 10), (5, 0)]
    assert abs(region([a, b], [0, 1]).area - 150) < 1e-6  # union
    assert abs(region([a, b]).area - 100) < 1e-6          # same group: even-odd hole in the overlap


def test_text_tool(monkeypatch):
    import os
    import pytest
    from app.geometry import text_import
    if not os.path.exists(text_import.FONTS["sans"]):
        pytest.skip("DejaVu font only present inside the container image")
    r = ProcessRequest(material_id="ply3", parts=[TextPart(text=TextSpec(value="Hi", height_mm=20), x_mm=100, y_mm=10)])
    res = process(ContainerJob(request=r, material=MAT, machine=M))
    assert res.errors == [] and res.preview[0].kind == "engrave"
    assert res.bbox_mm[2] == 100 and res.bbox_mm[1] == 10


def test_camel_case_job_parses_both_part_kinds():
    j = ContainerJob.model_validate({
        "request": {"materialId": "ply3", "parts": [
            {"kind": "file", "fileIndex": 0, "fileType": "svg", "xMm": 70, "yMm": 20, "scale": 1, "rotateDeg": 0},
            {"kind": "text", "text": {"value": "Hi", "font": "stencil", "heightMm": 10, "op": "cut"},
             "xMm": 5, "yMm": 5, "scale": 1, "rotateDeg": 90},
        ]},
        "material": MAT.model_dump(by_alias=True), "machine": M.model_dump(by_alias=True), "filesB64": [b64(SVG)],
    })
    assert isinstance(j.request.parts[0], FilePart) and isinstance(j.request.parts[1], TextPart)
    assert j.request.parts[1].rotate_deg == 90
    with pytest.raises(ValidationError):
        ProcessRequest(material_id="ply3", parts=[])
    with pytest.raises(ValidationError):
        ProcessRequest(material_id="ply3", parts=[FilePart(file_index=0, file_type="svg")] * 101)


def test_top_right_placement_anchor():
    res = process(multi(square(50, "none", stroke="black"), at=[(100, 10)]))
    assert res.errors == [], res.errors
    assert res.bbox_mm == (50, 10, 100, 60)
    assert res.part_boxes == [(50, 10, 100, 60)]


def test_rotated_part_still_anchors_top_right():
    svg = b"""<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="10mm" viewBox="0 0 40 10">
      <rect x="0" y="0" width="40" height="10" fill="none" stroke="black"/></svg>"""
    j = multi(svg, at=[(100, 10)])
    j.request.parts[0].rotate_deg = 90
    assert process(j).bbox_mm == (90, 10, 100, 50)


def test_two_parts_keep_engrave_fills_separate(monkeypatch):
    """Both SVGs use element group 0. If the groups collided, the overlap would be an even-odd hole."""
    from app import pipeline
    from app.geometry.hatch import region
    seen = {}

    def spy(polys, spacing, groups=None):
        seen.update(polys=polys, groups=groups)
        return hatch(polys, spacing, groups)
    monkeypatch.setattr(pipeline, "hatch", spy)
    res = process(multi(square(20), square(20), at=[(30, 10), (40, 10)]))  # x 10..30 and 20..40
    assert res.errors == [] and res.rd, res.errors
    assert len(set(seen["groups"])) == 2
    assert abs(region(seen["polys"], seen["groups"]).area - 600) < 0.01  # union: the overlap stays filled
    assert [(p.kind, p.part) for p in res.preview] == [("engrave", 0), ("engrave", 1)]


def test_preview_is_per_part_in_run_order():
    res = process(multi(SVG, square(10), at=[(70, 20), (100, 20)]))
    assert res.errors == [], res.errors
    assert [(p.kind, p.part) for p in res.preview] == [("engrave", 0), ("engrave", 1), ("score", 0), ("cut", 0)]
    assert res.part_boxes == [(20, 20, 70, 70), (90, 20, 100, 30)]
    assert res.bbox_mm == (20, 20, 100, 70)


def test_ignoring_a_colour_does_not_move_the_part():
    base = process(job(x_mm=100, y_mm=10))
    res = process(job(x_mm=100, y_mm=10, color_map={"stroke:#000000": "ignore"}))
    assert res.errors == [], res.errors
    assert [p.kind for p in res.preview] == ["engrave", "score"]
    # the red line sits at x 30..45, y 40 inside the 50 mm design, whose top-right is at (100, 10)
    score = [p.paths for p in res.preview if p.kind == "score"]
    assert score == [p.paths for p in base.preview if p.kind == "score"]
    assert res.part_boxes == [(60, 20, 95, 50)]  # blue square 10..20 and the red line, nothing moved


def test_all_ignored_part_has_no_box():
    res = process(multi(SVG, square(10, "#00ff00"), at=[(70, 20), (200, 20)], color_map={"fill:#00ff00": "ignore"}))
    assert res.errors == [], res.errors
    assert res.part_boxes == [(20, 20, 70, 70), None]
    assert all(p.part == 0 for p in res.preview)


def test_relative_mode_keeps_placement_but_checks_size():
    j = multi(SVG, at=[(2000, -50)], machine=M_REL)  # off the bed is fine: the job starts at the laser head
    res = process(j)
    assert res.errors == [] and res.rd, res.errors
    assert res.bbox_mm == (1950, -50, 2000, 0)
    j.request.parts[0].scale = 19  # 950 mm wide, bigger than the 914 mm bed
    res = process(j)
    assert res.rd is None and any("bigger than the laser bed" in e for e in res.errors)


def test_bad_file_index_is_a_friendly_error():
    j = multi(SVG, at=[(70, 20)])
    j.request.parts.append(FilePart(file_index=3, file_type="svg", x_mm=10, y_mm=10))
    res = process(j)
    assert res.rd is None and res.errors == ['The file for "part 2" is missing. Try adding it again.']
    j = multi(SVG, at=[(70, 20)])
    j.files_b64 = ["!!not base64!!"]
    res = process(j)
    assert res.rd is None and res.errors == ['The file for "part 1" got damaged on upload. Try again.']


def test_stretched_part_scales_width_and_height_separately():
    """Lock off: scale is width, scale_y is height, both in the part's own frame before rotation."""
    j = multi(square(50, "none", stroke="black"), at=[(200, 10)])
    j.request.parts[0].scale = 2.0
    j.request.parts[0].scale_y = 0.5
    res = process(j)
    x0, y0, x1, y1 = res.bbox_mm
    assert (round(x1 - x0), round(y1 - y0)) == (100, 25)
    j.request.parts[0].rotate_deg = 90  # a quarter turn swaps which way the stretch shows
    x0, y0, x1, y1 = process(j).bbox_mm
    assert (round(x1 - x0), round(y1 - y0)) == (25, 100)


def test_copies_can_share_one_file():
    """The pattern tool sends many parts pointing at the same fileIndex."""
    j = multi(square(50, "none", stroke="black"), at=[(200, 10)])
    j.request.parts = [FilePart(file_index=0, file_type="svg", x_mm=200 - 60 * i, y_mm=10) for i in range(3)]
    res = process(j)
    assert res.errors == [] and len([b for b in res.part_boxes if b]) == 3
