"""Material test card (teacher only): a grid of small squares, each its own layer with its own power and
speed, so the teacher can see which settings work on a new material.

Columns go left to right through the powers, rows top to bottom through the speeds. A small marked
corner sits just outside the top-left square, so the card can be read the right way up. Every layer
still goes through encode_job's clamp_settings (machine power ceiling, minimum speed).
"""
from __future__ import annotations

import base64
from typing import Literal

from pydantic import Field

from .geometry.hatch import hatch
from .models import MachineConfig, OpKind, OpSettings, _Camel
from .pipeline import estimate_seconds
from .ruida.encoder import EncLayer, encode_job, machine_converter

CELL_MM = 10.0
GAP_MM = 4.0
MARK_MM = 4.0


class CardRequest(_Camel):
    op: OpKind
    powers: list[float] = Field(min_length=2, max_length=7)
    speeds: list[float] = Field(min_length=2, max_length=7)
    machine: MachineConfig
    hatch_mm: float = Field(default=0.1, gt=0.02, le=1.0)
    air_assist: bool = True
    mark_power_pct: float = Field(default=15.0, ge=1, le=100)  # the corner mark: a light line
    mark_speed_mm_s: float = Field(default=100.0, gt=0, le=1000)


class CardCell(_Camel):
    row: int
    col: int
    power_pct: float
    speed_mm_s: float


class CardResponse(_Camel):
    rd: str
    cells: list[CardCell]
    size_mm: tuple[float, float]
    estimate_s: float
    kind: Literal["engrave", "score", "cut"]


def _square(x: float, y: float, s: float) -> list[tuple[float, float]]:
    return [(x, y), (x + s, y), (x + s, y + s), (x, y + s), (x, y)]


def build_test_card(req: CardRequest) -> CardResponse:
    m = req.machine
    for p in req.powers:
        if not 1 <= p <= 100:
            raise ValueError("Powers must be 1 to 100 %.")
    for s in req.speeds:
        if not 0 < s <= 1000:
            raise ValueError("Speeds must be above 0 and at most 1000 mm/s.")
    step = CELL_MM + GAP_MM
    left = MARK_MM + GAP_MM  # room for the corner mark
    top = MARK_MM + GAP_MM
    layers: list[tuple[OpKind, OpSettings, list[list[tuple[float, float]]]]] = []
    cells: list[CardCell] = []
    for r, speed in enumerate(req.speeds):
        for c, power in enumerate(req.powers):
            sq = _square(left + c * step, top + r * step, CELL_MM)
            paths = hatch([sq], req.hatch_mm) if req.op == "engrave" else [sq]
            s = OpSettings(speed_mm_s=speed, power_min_pct=power, power_max_pct=power, passes=1,
                           hatch_mm=req.hatch_mm, air_assist=req.air_assist)
            layers.append((req.op, s, paths))
            cells.append(CardCell(row=r, col=c, power_pct=power, speed_mm_s=speed))
    # corner mark: an L at the top-left, as a light Mark line
    mark = [[(0.0, MARK_MM), (0.0, 0.0), (MARK_MM, 0.0)]]
    layers.insert(0, ("score", OpSettings(speed_mm_s=req.mark_speed_mm_s, power_min_pct=req.mark_power_pct,
                                          power_max_pct=req.mark_power_pct, air_assist=req.air_assist), mark))
    w = left + len(req.powers) * step - GAP_MM
    h = top + len(req.speeds) * step - GAP_MM
    conv = machine_converter((0.0, 0.0, w, h), m)
    enc = [EncLayer(k, s, [[conv(x, y) for x, y in p] for p in paths]) for k, s, paths in layers]
    rd = base64.b64encode(encode_job(enc, m)).decode()
    return CardResponse(rd=rd, cells=cells, size_mm=(round(w, 1), round(h, 1)),
                            estimate_s=round(estimate_seconds(layers, m.travel_speed_mm_s), 1), kind=req.op)
