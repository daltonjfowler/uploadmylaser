"""Hostile or runaway designs: each must come back quickly with a friendly error, never hang the shared
container. Before these limits, every case here ran for minutes or ate gigabytes."""
import base64
import io
import sys
import time

import ezdxf
import pytest

from app.geometry import TOO_DETAILED, ImportWarnings, PointBudget, TooDetailed
from app.geometry.order import MAX_NEAREST, nearest_neighbour, order_cuts
from app.geometry.svg_import import MAX_SEGMENT_POINTS, _flatten
from app.models import ContainerJob, FilePart, MachineConfig, Material, OpSettings, ProcessRequest
from app.pipeline import process
from app.runner import BUSY, TOO_BIG, TOO_SLOW, Runner

MAT = Material(
    id="ply3", name="3mm plywood", thickness_mm=3,
    ops={
        "cut": OpSettings(speed_mm_s=15, power_min_pct=55, power_max_pct=65),
        "score": OpSettings(speed_mm_s=150, power_min_pct=15, power_max_pct=20),
        "engrave": OpSettings(speed_mm_s=250, power_min_pct=18, power_max_pct=25, hatch_mm=0.2),
    },
)
M = MachineConfig(job_origin_mode="absolute")
FAST_S = 5.0  # generous for a slow CI box; the unbounded versions took minutes


def job(data: bytes, file_type: str = "svg", copies: int = 1) -> ContainerJob:
    parts = [FilePart(file_index=0, file_type=file_type, x_mm=900, y_mm=10) for _ in range(copies)]
    r = ProcessRequest(material_id="ply3", parts=parts)
    return ContainerJob(request=r, material=MAT, machine=M, files_b64=[base64.b64encode(data).decode()])


def timed(j: ContainerJob):
    t = time.monotonic()
    res = process(j)
    return res, time.monotonic() - t


def svg(body: str) -> bytes:
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">{body}</svg>'.encode()


def dxf_bytes(doc) -> bytes:
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode()


# ---------- 1a: SVG curves with huge coordinates ----------

def test_svg_curve_with_huge_coordinates_is_quick():
    # svgelements' exact length recursed ~2^25 times here, then the loop built billions of points
    res, s = timed(job(svg('<path d="M0 0 C 1e15 1e15 -1e15 1e15 1e15 0" fill="none" stroke="black"/>')))
    assert s < FAST_S
    assert res.rd is None and res.errors == ["The design goes off the edge of the laser bed. Move it or make it smaller."]


def test_many_huge_curves_hit_the_point_budget():
    arcs = "".join(f'<path d="M0 {i} A 1e9 1e9 0 0 1 1e9 {i}" fill="none" stroke="black"/>' for i in range(40))
    res, s = timed(job(svg(arcs)))
    assert s < FAST_S
    assert res.errors == [TOO_DETAILED] and res.rd is None


def test_flatten_caps_one_segment_and_counts_the_budget():
    from svgelements import Path
    got = _flatten(Path("M0 0 Q 5e8 5e8 1e9 0"), 0.19, PointBudget(10**9))
    assert len(got[0][0]) == MAX_SEGMENT_POINTS + 1
    with pytest.raises(TooDetailed):
        _flatten(Path("M0 0 Q 50 50 100 0"), 0.001, PointBudget(1000))


def test_copies_share_one_point_budget():
    # 25 copies of a 20 000-point file: fine alone, too much together
    res, s = timed(job(svg('<path d="M0 0 Q 500 500 1000 0" fill="none" stroke="black"/>'), copies=25))
    assert s < FAST_S and res.errors == [TOO_DETAILED]


# ---------- 1b: a design far bigger than the bed ----------

def test_huge_engrave_area_is_refused_without_hatching():
    # 100 m square to engrave at 0.2 mm: half a million hatch rows before the fix
    res, s = timed(job(svg('<rect x="0" y="0" width="100000" height="100000" fill="#0000ff"/>')))
    assert s < FAST_S
    assert res.rd is None and any("edge" in e for e in res.errors)
    assert [p.kind for p in res.preview] == ["engrave"] and res.preview[0].paths  # still drawn for the student
    assert res.estimate_s == 0


def test_relative_mode_too_big_is_refused_without_hatching():
    j = job(svg('<rect x="0" y="0" width="100000" height="100000" fill="#0000ff"/>'))
    j.machine = MachineConfig(job_origin_mode="relative")
    res, s = timed(j)
    assert s < FAST_S and res.errors == ["The design is bigger than the laser bed. Make it smaller."]


# ---------- 1c: ordering a huge number of paths ----------

def test_nearest_neighbour_falls_back_above_the_cap():
    paths = [[(float(i % 200), float(i // 200)), (i % 200 + 0.5, float(i // 200))] for i in range(20_000)]
    t = time.monotonic()
    out = nearest_neighbour(paths)
    assert time.monotonic() - t < FAST_S
    assert len(out) == len(paths)
    assert sorted(map(tuple, (sorted(p) for p in out))) == sorted(map(tuple, (sorted(p) for p in paths)))


def test_order_cuts_keeps_every_path_and_inner_first_when_big():
    opens = [[(float(i % 100), float(i // 100) + 50), (i % 100 + 0.5, float(i // 100) + 50)] for i in range(MAX_NEAREST + 500)]
    outer = [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0), (0.0, 0.0)]
    inner = [(10.0, 10.0), (20.0, 10.0), (20.0, 20.0), (10.0, 20.0), (10.0, 10.0)]
    t = time.monotonic()
    out = order_cuts(opens + [outer, inner])
    assert time.monotonic() - t < FAST_S
    assert len(out) == len(opens) + 2
    assert out.index(inner) < out.index(outer) and out[-1] == outer  # the part comes free last


def test_many_score_lines_process_quickly():
    lines = "".join(f'<line x1="{i % 50}" y1="{i // 50}" x2="{i % 50 + 0.5}" y2="{i // 50}" stroke="red"/>' for i in range(5000))
    res, s = timed(job(svg(lines)))
    assert s < 3 * FAST_S
    assert res.errors == [] and res.rd


# ---------- 1d: DXF block bombs and huge circles ----------

def test_dxf_nested_block_bomb_is_refused():
    doc = ezdxf.new()
    doc.blocks.new("B0").add_line((0, 0), (1, 0))
    for level in range(1, 9):  # 10^8 lines once fully expanded
        b = doc.blocks.new(f"B{level}")
        for k in range(10):
            b.add_blockref(f"B{level - 1}", (k, 0))
    doc.modelspace().add_blockref("B8", (0, 0))
    res, s = timed(job(dxf_bytes(doc), "dxf"))
    assert s < FAST_S and res.errors == [TOO_DETAILED]


def test_dxf_minsert_grid_bomb_is_refused():
    doc = ezdxf.new()
    doc.blocks.new("B").add_line((0, 0), (1, 0))
    ref = doc.modelspace().add_blockref("B", (0, 0))
    ref.grid(size=(100_000, 100_000), spacing=(2, 2))
    res, s = timed(job(dxf_bytes(doc), "dxf"))
    assert res.errors == [TOO_DETAILED]
    # the point is that it stops at all; a busy test box can take a few seconds (runner kills at 25 s)
    assert s < 20


def test_dxf_huge_circle_stays_small():
    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4
    doc.modelspace().add_circle((0, 0), 1e12)
    res, s = timed(job(dxf_bytes(doc), "dxf"))
    assert s < FAST_S
    assert res.rd is None and res.errors and res.errors != [TOO_DETAILED]  # just too big for the bed


def test_dxf_normal_circle_is_unchanged():
    from app.geometry.dxf_import import import_dxf
    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4
    doc.modelspace().add_circle((0, 0), 50)
    items = import_dxf(dxf_bytes(doc), ImportWarnings())
    assert len(items) == 1 and len(items[0].pts) > 100  # still flattened at 0.05 mm


# ---------- 1e: a hard time limit per job ----------

def _sleepy(_job):
    time.sleep(120)


def _greedy(_job):
    raise MemoryError


def _broken(_job):
    raise KeyError("boom")


def _hog(_job):
    return bytearray(2 * 1024**3)  # 2 GiB, far past the cap


def test_runner_kills_a_job_that_runs_too_long():
    r = Runner(_sleepy, workers=1, time_limit=1.0, memory_limit=0)
    try:
        r.warm()
        before = r._idle.queue[0]
        t = time.monotonic()
        res = r.run(None)
        assert time.monotonic() - t < FAST_S
        assert res.errors == [TOO_SLOW]
        assert not before.proc.is_alive()  # the runaway process is gone, not left spinning
        assert r._idle.queue[0] is not before  # and a fresh one took its place
    finally:
        r.close()


def test_runner_replaces_a_worker_that_ran_out_of_memory():
    r = Runner(_greedy, workers=1, time_limit=10.0, memory_limit=0)
    try:
        r.warm()
        before = r._idle.queue[0]
        assert r.run(None).errors == [TOO_BIG]
        assert r._idle.queue[0] is not before
    finally:
        r.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="the memory cap is Linux only (it runs in the image)")
def test_runner_memory_cap_stops_a_hog():
    r = Runner(_hog, workers=1, time_limit=10.0)  # default cap
    try:
        r.warm()
        assert r.run(None).errors == [TOO_BIG]
    finally:
        r.close()


def test_runner_passes_other_failures_on():
    r = Runner(_broken, workers=1, time_limit=10.0, memory_limit=0)
    try:
        r.warm()
        with pytest.raises(RuntimeError):
            r.run(None)
    finally:
        r.close()


def test_runner_says_busy_when_every_worker_is_taken():
    r = Runner(_sleepy, workers=0, time_limit=0.2, memory_limit=0)
    assert r.run(None).errors == [BUSY]


def test_runner_runs_a_real_job():
    r = Runner(process, workers=1, time_limit=20.0)
    try:
        r.warm()
        res = r.run(job(svg('<rect x="0" y="0" width="20" height="20" fill="none" stroke="black"/>')))
        assert res.errors == [] and res.rd
    finally:
        r.close()


def test_process_route_goes_through_the_runner():
    from fastapi.testclient import TestClient
    from app.main import app
    j = job(svg('<rect x="0" y="0" width="20" height="20" fill="none" stroke="black"/>'))
    with TestClient(app) as c:
        r = c.post("/process", json=j.model_dump(by_alias=True))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["errors"] == [] and body["rd"] and body["frameRd"]


def test_grid_nearest_matches_the_plain_one():
    import random
    from app.geometry import order
    rnd = random.Random(7)
    paths = [[(rnd.uniform(0, 800), rnd.uniform(0, 600)), (rnd.uniform(0, 800), rnd.uniform(0, 600))] for _ in range(order.GRID_ABOVE * 4)]
    for rev in (True, False):
        grid = order._grid_nearest(paths, (0.0, 0.0), rev)
        # plain greedy, forced past the grid threshold
        old = order.GRID_ABOVE
        order.GRID_ABOVE = 10**9
        try:
            plain = order.nearest_neighbour(paths, (0.0, 0.0), rev)
        finally:
            order.GRID_ABOVE = old
        assert grid == plain


def test_big_floorplan_still_cuts_holes_first():
    # 1200 plates, each with a hole: every hole must be cut before its plate
    paths = []
    for i in range(1200):
        x, y = (i % 40) * 20.0, (i // 40) * 20.0
        paths.append([(x, y), (x + 15, y), (x + 15, y + 15), (x, y + 15), (x, y)])
        paths.append([(x + 5, y + 5), (x + 10, y + 5), (x + 10, y + 10), (x + 5, y + 10), (x + 5, y + 5)])
    t = time.monotonic()
    out = order_cuts(paths)
    assert time.monotonic() - t < FAST_S
    # a closed shape may come back starting at another corner: match it by its corners
    pos = {frozenset(p): k for k, p in enumerate(out)}
    assert len(out) == len(paths)
    for i in range(0, len(paths), 2):
        assert pos[frozenset(paths[i + 1])] < pos[frozenset(paths[i])]
