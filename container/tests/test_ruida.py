from pathlib import Path

import pytest

from app.models import MachineConfig, OpSettings
from app.ruida.decoder import dec14, dec35, decode_plain, decode_rd
from app.ruida.encoder import EncLayer, enc14, enc35, encode_job, machine_converter, to_machine
from app.ruida.swizzle import swizzle, swizzle_byte, unswizzle

GOLDEN = Path(__file__).resolve().parents[2] / "test" / "golden"
M = MachineConfig()
CUT = OpSettings(speed_mm_s=20, power_min_pct=30, power_max_pct=60, passes=1)


def test_swizzle_is_a_bijection_and_round_trips():
    assert len({swizzle_byte(i, 0x88) for i in range(256)}) == 256
    data = bytes(range(256))
    assert unswizzle(swizzle(data, 0x88), 0x88) == data


@pytest.mark.parametrize("v", [0, 1, 127, 128, 8191, -1, -8192, -3328])
def test_enc14_signed(v):
    assert dec14(enc14(v)) == v


@pytest.mark.parametrize("v", [0, 1, 914_000, 2**31 - 1])
def test_enc35(v):
    assert dec35(enc35(v)) == v


def test_to_machine_top_right_origin():
    assert to_machine(0, 0, M) == (914_000, 0)
    assert to_machine(914, 609, M) == (0, 609_000)


def _square(x=10.0, y=10.0, s=20.0):
    pts = [(x, y), (x + s, y), (x + s, y + s), (x, y + s), (x, y)]
    return [to_machine(px, py, M) for px, py in pts]


def test_encode_square_structure():
    raw = unswizzle(encode_job([EncLayer("cut", CUT, [_square()])], M), M.swizzle_magic)
    names = [c.name for c in decode_plain(raw)]
    assert names[0] == "REF_POINT_1"  # default: job anchored at the laser head
    assert "SET_ABSOLUTE" not in names
    assert names[-1] == "END_OF_FILE"
    assert names[-2] == "SET_FILE_SUM"
    assert names.count("MOVE_ABS") == 1
    assert sum(n.startswith("CUT_") for n in names) == 4
    # checksum covers every byte before SET_FILE_SUM, plus the D7
    body = raw[: raw.rindex(b"\xE5\x05")]
    assert dec35(raw[len(body) + 2: len(body) + 7]) == sum(body) + 0xD7


def test_absolute_mode_header():
    m = MachineConfig(job_origin_mode="absolute")
    names = [c.name for c in decode_plain(unswizzle(encode_job([EncLayer("cut", CUT, [_square()])], m), 0x88))]
    assert names[:2] == ["REF_POINT_2", "SET_ABSOLUTE"]


def test_relative_converter_puts_top_right_corner_at_zero():
    conv = machine_converter((100.0, 50.0, 140.0, 70.0), M)  # 40 x 20 mm design
    assert conv(140.0, 50.0) == (0, 0)             # design's top-right corner = laser head
    assert conv(100.0, 70.0) == (40_000, 20_000)   # bottom-left = furthest from the head


def test_cut_through_always_runs_last():
    """Even if layers arrive cut-first, the file runs engrave → mark → cut, with all cut passes at the end."""
    eng = OpSettings(speed_mm_s=200, power_min_pct=15, power_max_pct=15)
    mark = OpSettings(speed_mm_s=75, power_min_pct=20, power_max_pct=20)
    cut2 = OpSettings(speed_mm_s=20, power_min_pct=55, power_max_pct=55, passes=2)
    layers = [EncLayer("cut", cut2, [_square()]), EncLayer("engrave", eng, [_square(40)]), EncLayer("score", mark, [_square(70)])]
    cmds = decode_plain(unswizzle(encode_job(layers, M), M.swizzle_magic))
    speeds = [dec35(c.data) / 1000 for c in cmds if c.name == "SPEED_LASER_1"]
    assert speeds == [200, 75, 20]
    # nothing but cut moves after the cut layer starts
    start = max(i for i, c in enumerate(cmds) if c.name == "SPEED_LASER_1")
    assert not [c for c in cmds[start:] if c.name == "LAYER_NUMBER_PART"]


def test_power_is_clamped_to_machine_ceiling():
    hot = OpSettings(speed_mm_s=20, power_min_pct=100, power_max_pct=100)
    raw = unswizzle(encode_job([EncLayer("cut", hot, [_square()])], M), M.swizzle_magic)
    for c in decode_plain(raw):
        if c.name == "MAX_POWER_1":
            assert dec14(c.data, signed=False) == int(round(M.absolute_max_power_pct * 16383 / 100))


def test_frame_has_no_cut_commands():
    raw = unswizzle(encode_job([EncLayer("cut", CUT, [_square()])], M, laser_on=False), M.swizzle_magic)
    assert not any(c.name.startswith("CUT_") for c in decode_plain(raw))


GOLDEN_FILES = sorted(GOLDEN.glob("*.rd")) if GOLDEN.exists() else []
needs_golden = pytest.mark.skipif(not GOLDEN_FILES, reason="no golden files yet")

# Differences from LightBurn we make on purpose (see encoder.py comments).
# SET_ABSOLUTE/REF_POINT_*: the nameplate file was saved with a different "Start From" than we use.
SKIP = {"REF_POINT_1", "REF_POINT_2", "REF_POINT_0", "SET_ABSOLUTE", "SET_VARIABLE"}
SKIP_PREFIX = ("ELEMENT_",)
MOTION = ("MOVE_", "CUT_")


def _structure(cmds):
    """Command names with motion collapsed, so different drawings compare equal."""
    out = []
    for c in cmds:
        if c.name in SKIP or c.name.startswith(SKIP_PREFIX):
            continue
        n = "MOTION" if c.name.startswith(MOTION) else c.name
        if not (out and out[-1] == n == "MOTION"):
            out.append(n)
    return out


@needs_golden
def test_golden_files_decode_cleanly():
    for f in GOLDEN_FILES:
        cmds = decode_rd(f.read_bytes(), 0x88)
        assert cmds[-1].name == "END_OF_FILE", f.name
        assert not [c for c in cmds if c.name.startswith("UNKNOWN")], f.name
        raw = unswizzle(f.read_bytes(), 0x88)
        body = raw[: raw.rindex(b"\xE5\x05")]
        assert dec35(raw[len(body) + 2: len(body) + 7]) == sum(body) + 0xD7, f"{f.name} checksum"


@needs_golden
def test_encoder_layout_matches_lightburn():
    """Same command skeleton as LightBurn for a job with the same number of layers."""
    for f in GOLDEN_FILES:
        cmds = decode_rd(f.read_bytes(), 0x88)
        golden = _structure(cmds)
        # work mode 2 = scan (fill engrave), else vector
        kinds = ["engrave" if c.data[1:2] == b"\x02" else "cut" for c in cmds if c.name == "WORK_MODE_PART"]
        layers = [EncLayer(k, CUT, [_square(10 + 30 * i)]) for i, k in enumerate(kinds)]
        ours = _structure(decode_plain(unswizzle(encode_job(layers, M), M.swizzle_magic)))
        assert ours == golden, f.name


@needs_golden
def test_absolute_square_bounds_match_lightburn():
    """20mm_absolute.rd: a 20 mm square at machine (15, 29)–(35, 49), cut with 2 passes."""
    f = GOLDEN / "20mm_absolute.rd"
    if not f.exists():
        pytest.skip("20mm_absolute.rd missing")
    golden = {c.name: c.data for c in decode_rd(f.read_bytes(), 0x88)}
    sq = [(15_000, 29_000), (15_000, 49_000), (35_000, 49_000), (35_000, 29_000), (15_000, 29_000)]
    two = CUT.model_copy(update={"passes": 2})
    ours = {c.name: c.data for c in decode_plain(unswizzle(encode_job([EncLayer("cut", two, [sq])], M), M.swizzle_magic))}
    for name in ("PROCESS_TOP_LEFT", "PROCESS_BOTTOM_RIGHT", "ARRAY_ADD", "ARRAY_UNIT_SIZE", "ARRAY_REPEAT", "PART_MIN_POINT"):
        assert ours[name] == golden[name], name


def test_encoder_never_emits_file_commands():
    # Safety: E8 00 deletes controller files (E8 00 00 00 ... deletes all). The container never sends any
    # E8 command. The one allowed delete lives in web/src/ruida/panel.ts (deleteOneFile).
    layers = [EncLayer("engrave", CUT, [_square(40, 40)]), EncLayer("cut", CUT, [_square()])]
    for laser_on in (True, False):
        cmds = decode_plain(unswizzle(encode_job(layers, M, laser_on=laser_on), M.swizzle_magic))
        assert not [c for c in cmds if c.raw[0] == 0xE8], "encoder emitted an E8 file command"
