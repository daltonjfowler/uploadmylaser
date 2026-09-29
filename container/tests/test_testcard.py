"""Material test card: every square its own layer, clamped like any job, never a file command."""
import base64

import pytest

from app.models import MachineConfig
from app.ruida.decoder import dec14, decode_rd
from app.testcard import CardRequest, build_test_card

M = MachineConfig(absolute_max_power_pct=80.0, min_speed_mm_s=2.0)


def cmds(res):
    return decode_rd(base64.b64decode(res.rd), M.swizzle_magic)


def test_grid_has_one_layer_per_square_plus_the_corner_mark():
    res = build_test_card(CardRequest(op="engrave", powers=[10, 20, 30], speeds=[100, 200], machine=M))
    assert len(res.cells) == 6
    numbers = [c for c in cmds(res) if c.name == "LAYER_NUMBER_PART"]
    assert len(numbers) == 7
    assert res.size_mm[0] > 3 * 10 and res.estimate_s > 0


def test_every_square_is_clamped_to_the_machine_ceiling_and_speed_floor():
    res = build_test_card(CardRequest(op="cut", powers=[50, 100], speeds=[0.5, 20], machine=M))
    maxes = [dec14(c.data[1:3], signed=False) / 16383 * 100 for c in cmds(res) if c.name == "MAX_POWER_1_PART"]
    assert maxes and max(maxes) <= 80.0 + 0.01
    assert not [c for c in cmds(res) if c.raw[0] == 0xE8]


def test_bad_values_are_refused():
    with pytest.raises(ValueError):
        build_test_card(CardRequest(op="score", powers=[0, 10], speeds=[10, 20], machine=M))
    with pytest.raises(Exception):
        CardRequest(op="score", powers=[10] * 8, speeds=[10, 20], machine=M)
