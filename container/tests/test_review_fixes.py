"""Code review fixes (2026-10-09): non-finite coordinates, join tolerance and ring dedupe, one-pass frame,
MINSERT and hatch budgets, power clamp, test card labels, 1 mm text."""
import base64
import io

import ezdxf

from app.geometry import TOO_DETAILED, Item
from app.geometry.order import join_paths
from app.models import ContainerJob, FilePart, MachineConfig, Material, OpSettings, ProcessRequest, TextSpec
from app.pipeline import process
from app.ruida.decoder import decode_rd
from app.ruida.encoder import clamp_settings, enc_power
from app.testcard import CardRequest, build_test_card

M = MachineConfig()


def mat(**ops):
    return Material(id="m", name="m", thickness_mm=3, ops=ops)


ENGRAVE = OpSettings(speed_mm_s=250, power_min_pct=18, power_max_pct=25, hatch_mm=0.2)
CUT = OpSettings(speed_mm_s=15, power_min_pct=55, power_max_pct=65)


def run(data: bytes, file_type: str = "svg", material: Material | None = None) -> object:
    r = ProcessRequest(material_id="m", parts=[FilePart(file_index=0, file_type=file_type, x_mm=100, y_mm=10)])
    return process(ContainerJob(request=r, material=material or mat(cut=CUT, engrave=ENGRAVE), machine=M,
                                files_b64=[base64.b64encode(data).decode()]))


def svg(body: str) -> bytes:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">{body}</svg>').encode()


# ---------- 5: NaN / inf ----------

def test_infinite_svg_coordinates_are_a_friendly_error():
    res = run(svg('<path d="M0 0 L1e400 0 L10 10 Z" fill="none" stroke="black"/>'))
    assert res.rd is None and res.errors and "couldn't read" in res.errors[0]


def test_nothing_non_finite_gets_past_placement(monkeypatch):
    from app import pipeline
    monkeypatch.setattr(pipeline, "_import_part", lambda *a: [Item("k", "cut", [(0.0, 0.0), (float("nan"), 5.0), (5.0, 5.0)], False)])
    res = run(svg(""))
    assert res.rd is None and res.errors == ["We couldn't read \"part 1\". Try exporting it again."]


# ---------- 6: join tolerance, ring dedupe ----------

def test_ends_a_hair_apart_across_a_cell_edge_still_join():
    a = [(0.0, 0.0), (0.0749999, 0.0)]  # 0.0749999 / 0.05 rounds to 1 ...
    b = [(0.0750001, 0.0), (1.0, 0.0)]  # ... and 0.0750001 / 0.05 to 2
    assert len(join_paths([a, b])) == 1


def test_same_ring_from_another_corner_or_the_other_way_is_cut_once():
    sq = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
    other_corner = [(10.0, 10.0), (0.0, 10.0), (0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
    reversed_ = [(10.0, 0.0), (0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0)]
    assert len(join_paths([sq, other_corner, reversed_])) == 1
    smaller = [(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0), (1.0, 1.0)]
    assert len(join_paths([sq, smaller])) == 2


# ---------- 7: the frame traces the box once ----------

def test_frame_traces_once_even_with_passes():
    many = mat(engrave=ENGRAVE.model_copy(update={"passes": 3}))
    res = run(svg('<rect x="0" y="0" width="20" height="20" fill="#0000ff"/>'), material=many)
    assert res.errors == [] and res.frame_rd
    moves = [c for c in decode_rd(base64.b64decode(res.frame_rd)) if c.name == "MOVE_ABS"]
    assert len(moves) == 5  # the four corners and back, once


# ---------- 8: unbounded work ----------

def test_minsert_of_an_empty_block_is_refused():
    doc = ezdxf.new()
    doc.blocks.new("EMPTY")
    doc.modelspace().add_line((0, 0), (10, 0))
    doc.modelspace().add_blockref("EMPTY", (0, 0)).grid(size=(5_000, 5_000), spacing=(1, 1))
    s = io.StringIO()
    doc.write(s)
    assert run(s.getvalue().encode(), "dxf").errors == [TOO_DETAILED]


def test_hatch_lines_count_against_a_point_budget(monkeypatch):
    from app import pipeline
    body = '<rect x="0" y="0" width="20" height="20" fill="#0000ff"/>'
    assert run(svg(body)).errors == []
    monkeypatch.setattr(pipeline, "MAX_POINTS", 150)  # 100 scan lines = 200 points; the square is 5
    assert run(svg(body)).errors == [TOO_DETAILED]


# ---------- 9: power stays 0..100 ----------

def test_negative_or_nan_ceiling_never_wraps_to_high_power():
    s = OpSettings(speed_mm_s=20, power_min_pct=30, power_max_pct=60)
    for ceiling in (-5.0, float("nan")):
        c = clamp_settings(s, MachineConfig(absolute_max_power_pct=ceiling))
        assert c.power_max_pct == 0 and c.power_min_pct == 0
    assert enc_power(-5) == enc_power(0) and enc_power(150) == enc_power(100)


# ---------- 10: test card labels say what the laser gets ----------

def test_card_labels_report_clamped_values():
    m = MachineConfig(absolute_max_power_pct=80.0, min_speed_mm_s=2.0)
    res = build_test_card(CardRequest(op="cut", powers=[50, 100], speeds=[0.5, 20], machine=m))
    assert max(c.power_pct for c in res.cells) == 80.0
    assert min(c.speed_mm_s for c in res.cells) == 2.0


# ---------- 11: 1 mm text is allowed, as the Worker allows it ----------

def test_one_mm_text_is_valid():
    assert TextSpec(value="Hi", height_mm=1).height_mm == 1
