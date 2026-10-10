"""Cut order (holes first, nearest ready next, passes per batch), even-odd fill speed and figure 8s,
and engrave/score travel."""
import base64
import math

from shapely.geometry import Polygon

from app.geometry import Item, areas
from app.geometry.areas import area_of, even_odd
from app.geometry.hatch import hatch, region
from app.geometry.order import nearest_neighbour, order_cut_groups, order_cuts
from app.geometry.shapes_ops import weld
from app.models import ContainerJob, FilePart, MachineConfig, Material, OpSettings, ProcessRequest
from app.pipeline import process
from app.ruida.decoder import dec35, decode_plain
from app.ruida.encoder import EncLayer, encode_job
from app.ruida.swizzle import unswizzle


def sq(x, y, s):
    return [(x, y), (x + s, y), (x + s, y + s), (x, y + s), (x, y)]


def travel(paths, start=(0.0, 0.0)):
    t, cur = 0.0, start
    for p in paths:
        t += math.dist(cur, p[0])
        cur = p[-1]
    return t


def ring_pos(out):
    return {frozenset(p): k for k, p in enumerate(out)}


# ---------- 1: nearly closed outlines and open outlines still wait for their holes ----------

def test_outline_that_misses_closing_by_a_hair_is_cut_after_its_hole():
    outer = [(0.0, 0.0), (50.0, 0.0), (50.0, 50.0), (0.0, 50.0), (0.0, 0.2)]  # no Z, 0.2 mm short
    hole = sq(20, 20, 10)
    out = order_cuts([outer, hole])
    assert frozenset(out[0]) == frozenset(hole) and out[1] in (outer, outer[::-1])


def test_open_outline_around_a_hole_is_cut_after_it():
    u = [(0.0, 0.0), (50.0, 0.0), (50.0, 50.0), (0.0, 50.0), (0.0, 30.0)]  # 20 mm gap: really open
    hole = sq(20, 20, 10)
    out = order_cuts([u, hole])
    assert frozenset(out[0]) == frozenset(hole)


def test_slit_inside_a_part_is_cut_before_the_part():
    outer = sq(0, 0, 50)
    slit = [(10.0, 25.0), (40.0, 25.0)]
    out = order_cuts([outer, slit])
    assert frozenset(out[-1]) == frozenset(outer)


# ---------- A: nearest ready order ----------

def _plates(n_x=6, n_y=5, holes=3):
    """n_x * n_y parts of 30 mm, each with `holes` 5 mm holes; [(outer, [holes])]."""
    parts = []
    for gx in range(n_x):
        for gy in range(n_y):
            x, y = gx * 40.0, gy * 40.0
            parts.append((sq(x, y, 30), [sq(x + 3 + 9 * h, y + 12, 5) for h in range(holes)]))
    return parts


def test_every_hole_before_its_part_and_parts_one_at_a_time():
    parts = _plates()
    paths = [p for outer, hs in parts for p in [outer, *hs]]
    out = order_cuts(paths)
    assert len(out) == len(paths)
    pos = ring_pos(out)
    for outer, hs in parts:
        assert all(pos[frozenset(h)] < pos[frozenset(outer)] for h in hs)
    # closed shapes are entered at a corner but keep every point and their direction
    for p in out:
        assert p[0] == p[-1] and len(p) == 5


def test_nearest_ready_travels_less_than_whole_bed_groups():
    parts = _plates()
    paths = [p for outer, hs in parts for p in [outer, *hs]]
    old = nearest_neighbour([h for _, hs in parts for h in hs]) + nearest_neighbour([o for o, _ in parts])
    new = order_cuts(paths)
    assert travel(new) < 0.75 * travel(old)


def test_head_start_is_used():
    a, b = sq(0, 0, 5), sq(200, 0, 5)
    assert frozenset(order_cuts([a, b], start=(210.0, 0.0))[0]) == frozenset(b)


def test_open_lines_reverse_to_the_nearer_end():
    line = [(0.0, 0.0), (100.0, 0.0)]
    assert order_cuts([line], start=(100.0, 1.0))[0] == line[::-1]


# ---------- 2: every pass of a part's holes before its outline ----------

def test_batches_split_holes_from_their_outline():
    outer, hole = sq(0, 0, 50), sq(20, 20, 10)
    groups = order_cut_groups([outer, hole])
    assert [len(g) for g in groups] == [1, 1]
    assert frozenset(groups[0][0]) == frozenset(hole)


def _moves(rd: bytes, m: MachineConfig):
    return [(dec35(c.data[:5]), dec35(c.data[5:10])) for c in decode_plain(unswizzle(rd, m.swizzle_magic)) if c.name == "MOVE_ABS"]


def test_two_passes_cut_the_hole_twice_before_the_outline():
    m = MachineConfig()
    hole = [(20_000, 20_000), (30_000, 20_000), (30_000, 30_000), (20_000, 20_000)]
    outer = [(0, 0), (50_000, 0), (50_000, 50_000), (0, 0)]
    s = OpSettings(speed_mm_s=20, power_min_pct=50, power_max_pct=50, passes=2)
    moves = _moves(encode_job([EncLayer("cut", s, [hole, outer], [1, 1])], m), m)
    assert moves == [hole[0], hole[0], outer[0], outer[0]]
    # no batches (or batches that don't add up): the old whole-layer passes
    for b in (None, [5]):
        assert _moves(encode_job([EncLayer("cut", s, [hole, outer], b)], m), m) == [hole[0], outer[0], hole[0], outer[0]]


def test_pipeline_runs_hole_passes_before_the_outline():
    svg = (b'<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">'
           b'<rect x="0" y="0" width="50" height="50" fill="none" stroke="black"/>'
           b'<rect x="20" y="20" width="10" height="10" fill="none" stroke="black"/></svg>')
    mat = Material(id="m", name="m", thickness_mm=3,
                   ops={"cut": OpSettings(speed_mm_s=15, power_min_pct=55, power_max_pct=65, passes=3)})
    m = MachineConfig()
    j = ContainerJob(request=ProcessRequest(material_id="m", parts=[FilePart(file_index=0, file_type="svg", x_mm=100, y_mm=10)]),
                     material=mat, machine=m, files_b64=[base64.b64encode(svg).decode()])
    res = process(j)
    assert res.errors == [], res.errors
    moves = _moves(base64.b64decode(res.rd), m)
    assert len(moves) == 6 and len(set(moves[:3])) == 1 and len(set(moves[3:])) == 1 and moves[0] != moves[3]
    # the hole is the small one: its start is inside the outline's box, 20..30 mm from the corner
    assert 20_000 <= moves[0][0] <= 30_000 and 20_000 <= moves[0][1] <= 30_000


# ---------- 3: fast even-odd ----------

def test_even_odd_matches_one_at_a_time_xor_with_three_way_overlaps():
    shapes = [Polygon(sq(0, 0, 10)), Polygon(sq(5, 0, 10)), Polygon(sq(2, 2, 10)), Polygon(sq(40, 40, 3))]
    slow = Polygon()
    for s in shapes:
        slow = slow.symmetric_difference(s)
    fast = even_odd(shapes)
    assert abs(fast.area - slow.area) < 1e-9 and fast.symmetric_difference(slow).area < 1e-9


def test_even_odd_only_xors_shapes_that_touch(monkeypatch):
    """2000 plates with a hole each, one fill group (a DXF part): each overlay sees one plate and its hole,
    never the growing whole (that took 97 s at 2000 shapes)."""
    seen = []
    real = areas._xor_all
    monkeypatch.setattr(areas, "_xor_all", lambda gs: seen.append(len(gs)) or real(gs))
    polys = []
    for i in range(1000):
        x, y = (i % 40) * 12.0, (i // 40) * 12.0
        polys += [sq(x, y, 10), sq(x + 3, y + 3, 4)]
    g = region(polys, [0] * len(polys))
    assert max(seen) == 2 and len(seen) == 1000
    assert abs(g.area - 1000 * (100 - 16)) < 1e-6


# ---------- 4: self-crossing rings keep both loops ----------

FIG8 = [(0.0, 0.0), (10.0, 10.0), (10.0, 0.0), (0.0, 10.0), (0.0, 0.0)]  # a bowtie: two 25 mm² triangles


def test_figure_8_keeps_both_loops():
    assert abs(area_of(FIG8).area - 50) < 1e-9
    assert abs(region([FIG8]).area - 50) < 1e-9
    welded = weld([Item("k", "cut", FIG8, True)])
    assert abs(sum(Polygon(i.pts).area for i in welded) - 50) < 1e-9
    lines = hatch([FIG8], 1.0)
    assert any(x < 5 for ln in lines for x, _ in ln) and any(x > 5 for ln in lines for x, _ in ln)


def test_figure_8_cut_order_is_fine():
    hole = sq(1, 4, 1)  # inside the left loop
    assert frozenset(order_cuts([FIG8, hole])[0]) == frozenset(hole)


# ---------- B: engrave one area at a time ----------

def test_two_separate_squares_engrave_one_after_the_other():
    a, b = sq(0, 0, 10), sq(50, 0, 10)
    lines = hatch([a, b], 0.5)
    sides = [ln[0][0] > 30 for ln in lines]
    assert sum(1 for s, t in zip(sides, sides[1:]) if s != t) == 1  # crosses between them once
    assert len(lines) == 40


def test_engrave_starts_at_the_nearest_area_and_corner():
    a, b = sq(0, 0, 10), sq(50, 0, 10)
    lines = hatch([a, b], 0.5, start=(60.0, 10.0))
    assert lines[0][0][0] > 30  # starts on the right square
    assert math.dist(lines[0][0], (60.0, 10.0)) < 1  # at its bottom-right corner


def test_hatching_per_area_keeps_the_same_rows():
    a, b = sq(0, 0, 10), sq(50, 3.3, 10)
    ys = {round(ln[0][1], 6) for ln in hatch([a, b], 0.5)}
    # one row grid for the whole job: every row is spacing/2 + k * spacing from the top of everything
    assert all(abs(((y - 0.25) / 0.5) - round((y - 0.25) / 0.5)) < 1e-6 for y in ys)


# ---------- C: each layer starts where the previous one ended ----------

def test_score_starts_where_engrave_ended(monkeypatch):
    from app import pipeline
    got = {}
    real_nn, real_hatch = pipeline.nearest_neighbour, pipeline.hatch

    def nn(paths, start=(0.0, 0.0), *a):
        got["score_start"] = start
        return real_nn(paths, start, *a)

    def h(*a, **k):
        out = real_hatch(*a, **k)
        got["engrave_end"] = out[-1][-1]
        return out
    monkeypatch.setattr(pipeline, "nearest_neighbour", nn)
    monkeypatch.setattr(pipeline, "hatch", h)
    svg = (b'<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">'
           b'<rect x="0" y="0" width="10" height="10" fill="#0000ff"/>'
           b'<line x1="30" y1="40" x2="45" y2="40" stroke="red"/></svg>')
    j = ContainerJob(request=ProcessRequest(material_id="ply3", parts=[FilePart(file_index=0, file_type="svg", x_mm=100, y_mm=10)]),
                     material=Material(id="ply3", name="p", thickness_mm=3, ops={
                         "score": OpSettings(speed_mm_s=150, power_min_pct=15, power_max_pct=20),
                         "engrave": OpSettings(speed_mm_s=250, power_min_pct=18, power_max_pct=25, hatch_mm=0.5)}),
                     machine=MachineConfig(), files_b64=[base64.b64encode(svg).decode()])
    assert process(j).errors == []
    assert got["score_start"] == got["engrave_end"]
