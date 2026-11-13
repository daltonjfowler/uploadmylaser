"""laserFile: false (Dalton 2026-11-12: build the laser file only on Send). Every edit asks only for what the
page draws; the fill, cut order and laser file are skipped, and the drawing is the same as a full build."""
import base64
import time

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
M = MachineConfig(job_origin_mode="absolute", bed_width_mm=1219, bed_height_mm=914)


def board(n: int = 6) -> bytes:
    body = '<rect x="1" y="1" width="298" height="228" fill="none" stroke="#000"/>'
    for k in range(n):
        x, y = 10 + (k % 4) * 72, 10 + (k // 4) * 72
        body += f'<rect x="{x}" y="{y}" width="66" height="66" fill="none" stroke="#000"/>'
        body += f'<path d="M{x + 8} {y + 8}h30v30h-30z M{x + 15} {y + 15}v16h16v-16z" fill="#00f" fill-rule="evenodd"/>'
        body += f'<line x1="{x + 6}" y1="{y + 56}" x2="{x + 60}" y2="{y + 56}" stroke="#f00"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="230mm" viewBox="0 0 300 230">{body}</svg>'.encode()


def run(data: bytes, laser_file: bool, x: float = 400):
    r = ProcessRequest(material_id="ply3", parts=[FilePart(file_index=0, file_type="svg", x_mm=x, y_mm=10)], laser_file=laser_file)
    return process(ContainerJob(request=r, material=MAT, machine=M, files_b64=[base64.b64encode(data).decode()]))


def test_preview_draws_the_same_as_a_full_build_but_makes_no_laser_file():
    full, quick = run(board(), True), run(board(), False)
    assert full.rd and full.frame_rd
    assert quick.rd is None and quick.frame_rd is None
    assert quick.errors == full.errors == []
    assert quick.preview == full.preview
    assert quick.part_boxes == full.part_boxes and quick.part_colors == full.part_colors
    assert quick.bbox_mm == full.bbox_mm and quick.warnings == full.warnings


def test_preview_time_is_close_to_the_real_one():
    full, quick = run(board(), True), run(board(), False)
    assert full.estimate_s > 0 and quick.estimate_s > 0
    assert 0.6 * full.estimate_s <= quick.estimate_s <= 1.1 * full.estimate_s, (quick.estimate_s, full.estimate_s)


def test_preview_still_says_off_the_bed():
    quick = run(board(), False, x=100)  # 300 mm wide, its right edge at 100: off the left side
    assert any("off the edge" in e for e in quick.errors)


def test_preview_is_much_quicker_on_a_detailed_board():
    data = board(12)
    t = time.perf_counter()
    run(data, True)
    full_s = time.perf_counter() - t
    t = time.perf_counter()
    run(data, False)
    quick_s = time.perf_counter() - t
    assert quick_s < full_s, (quick_s, full_s)
