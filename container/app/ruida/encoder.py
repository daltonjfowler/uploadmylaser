"""Build a Ruida .rd job from mm polylines.

The command layout mirrors what **LightBurn writes for this RDC6445S**, decoded from
test/golden/*.rd (see docs/HARDWARE.md). Command names and encodings come from MeerK40t (MIT).
Units on the wire: µm for coordinates, µm/s for speed, 14-bit fraction of 16383 for power.
Everything here works in *machine* coordinates: see `to_machine()` for the bed → machine flip.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from ..models import MachineConfig, OpKind, OpSettings
from .swizzle import swizzle

# ---- number packing: every data byte is 7-bit, commands have the high bit set ----


def enc14(v: float) -> bytes:
    v = int(round(v))
    return bytes([(v >> 7) & 0x7F, v & 0x7F])


def enc35(v: float) -> bytes:
    v = int(round(v))
    return bytes([(v >> 28) & 0x7F, (v >> 21) & 0x7F, (v >> 14) & 0x7F, (v >> 7) & 0x7F, v & 0x7F])


def enc_power(pct: float) -> bytes:
    return enc14(pct * 16383 / 100.0)


def enc_speed(mm_s: float) -> bytes:
    return enc35(mm_s * 1000)


REL_LIMIT_UM = 8191  # 14-bit signed relative moves

# "Start From: Absolute Coords" in LightBurn = D8 10 + E6 01 (verified: test/golden/20mm_absolute.rd).
ABSOLUTE_COORDS = b"\xD8\x10\xE6\x01"
# Job anchored at the laser head, coordinates from the job's own corner (the class nameplate file: D8 11,
# no E6 01, bbox starting at 0,0). VERIFY on the machine that D8 11 means "current head position" and not
# a stored user origin (docs/HARDWARE.md).
RELATIVE_TO_HEAD = b"\xD8\x11"

RUN_ORDER: dict[str, int] = {"engrave": 0, "score": 1, "cut": 2}

# Engrave layers use the controller's scan mode, exactly like LightBurn's Fill (test/golden/20mm_fill.rd).
SCAN_KINDS = {"engrave"}


# ---- job model the encoder consumes ----

Um = int
Poly = list[tuple[Um, Um]]


@dataclass
class EncLayer:
    kind: OpKind
    settings: OpSettings
    paths: list[Poly] = field(default_factory=list)  # machine µm, already ordered


# 0xRRGGBB as LightBurn writes it (its layer 00 black = 0, layer 01 blue = 0x0000FF). Shown on the panel.
LAYER_COLORS = {"cut": 0x000000, "score": 0xFF0000, "engrave": 0x0000FF}  # black cut, red mark, blue engrave


def to_machine(x_mm: float, y_mm: float, m: MachineConfig) -> tuple[Um, Um]:
    """Bed coords (origin top-left, y down, mm) → absolute machine coords (µm from the home corner)."""
    x = m.bed_width_mm - x_mm if m.origin.endswith("right") else x_mm
    y = m.bed_height_mm - y_mm if m.origin.startswith("bottom") else y_mm
    return int(round(x * 1000)), int(round(y * 1000))


Converter = Callable[[float, float], tuple[Um, Um]]


def machine_converter(bbox_mm: tuple[float, float, float, float], m: MachineConfig) -> Converter:
    """Bed mm → wire µm for this job. In relative mode the design's `origin` corner (top-right by
    default) becomes (0, 0), so the job grows away from the laser head the same way the machine
    grows away from home, and every coordinate stays positive."""
    if m.job_origin_mode == "absolute":
        return lambda x, y: to_machine(x, y, m)
    x0, y0, x1, y1 = bbox_mm
    right, bottom = m.origin.endswith("right"), m.origin.startswith("bottom")

    def conv(x: float, y: float) -> tuple[Um, Um]:
        mx = (x1 - x) if right else (x - x0)
        my = (y1 - y) if bottom else (y - y0)
        return int(round(mx * 1000)), int(round(my * 1000))
    return conv


def clamp_settings(s: OpSettings, m: MachineConfig) -> OpSettings:
    """Last line of defence: nothing leaves the server above the machine ceiling."""
    mx = min(s.power_max_pct, m.absolute_max_power_pct)
    mn = min(s.power_min_pct, mx)
    return s.model_copy(update={
        "power_max_pct": mx,
        "power_min_pct": mn,
        "speed_mm_s": max(s.speed_mm_s, m.min_speed_mm_s),
        "passes": max(1, min(s.passes, 10)),
    })


class RdWriter:
    def __init__(self) -> None:
        self.buf = bytearray()
        self.x: Um = 0
        self.y: Um = 0

    def __call__(self, *parts: bytes) -> None:
        for p in parts:
            self.buf += p

    def move(self, x: Um, y: Um) -> None:
        """Travel (laser off). LightBurn always uses absolute moves for travel."""
        self(b"\x88", enc35(x), enc35(y))
        self.x, self.y = x, y

    def cut(self, x: Um, y: Um) -> None:
        dx, dy = x - self.x, y - self.y
        if dx == 0 and dy == 0:
            return
        if abs(dx) > REL_LIMIT_UM or abs(dy) > REL_LIMIT_UM:
            self(b"\xA8", enc35(x), enc35(y))
        elif dx == 0:
            self(b"\xAB", enc14(dy))
        elif dy == 0:
            self(b"\xAA", enc14(dx))
        else:
            self(b"\xA9", enc14(dx), enc14(dy))
        self.x, self.y = x, y


def _bounds(paths: list[Poly]) -> tuple[Um, Um, Um, Um]:
    xs = [p[0] for poly in paths for p in poly]
    ys = [p[1] for poly in paths for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def _pt(x: Um, y: Um) -> bytes:
    return enc35(x) + enc35(y)


def encode_job(layers: list[EncLayer], m: MachineConfig, *, laser_on: bool = True) -> bytes:
    """Return swizzled bytes ready to stream over USB.

    laser_on=False emits the same file with move-only commands and zero power (used for Frame).
    """
    layers = [ly for ly in layers if ly.paths]
    if not layers:
        raise ValueError("nothing to cut")
    # Cut through ALWAYS runs last, including every one of its passes. Once a part is cut free it can
    # shift or drop, so any engraving or marking after that would land in the wrong place.
    layers.sort(key=lambda ly: RUN_ORDER[ly.kind])  # stable: keeps order within a kind
    layers = [EncLayer(ly.kind, clamp_settings(ly.settings, m), ly.paths) for ly in layers]
    w = RdWriter()
    x0, y0, x1, y1 = _bounds([p for ly in layers for p in ly.paths])

    def powers(s: OpSettings) -> tuple[float, float]:
        return (s.power_min_pct, s.power_max_pct) if laser_on else (0.0, 0.0)

    # --- header (order as LightBurn writes it) ---
    w(ABSOLUTE_COORDS if m.job_origin_mode == "absolute" else RELATIVE_TO_HEAD)
    w(b"\xF0")                      # ref point set
    w(b"\xF1\x02", b"\x00")             # enable block cutting: off
    w(b"\xD8\x00")                      # start process
    w(b"\xE7\x06", enc35(0), enc35(0))  # feed repeat
    w(b"\xE7\x38", b"\x00")             # feed auto pause off
    w(b"\xE7\x03", _pt(x0, y0))         # process top-left
    w(b"\xE7\x07", _pt(x1, y1))         # process bottom-right
    w(b"\xE7\x50", _pt(x0, y0))         # document min
    w(b"\xE7\x51", _pt(x1, y1))         # document max
    w(b"\xE7\x04", enc14(1), enc14(1), enc14(0), enc14(0), enc14(0), enc14(0), enc14(0))  # process repeat
    w(b"\xE7\x05", b"\x00")             # array direction

    for part, ly in enumerate(layers):
        pmin, pmax = powers(ly.settings)
        lx0, ly0, lx1, ly1 = _bounds(ly.paths)
        pb = bytes([part])
        w(b"\xC9\x04", pb, enc_speed(ly.settings.speed_mm_s))
        w(b"\xC6\x31", pb, enc_power(pmin))
        w(b"\xC6\x32", pb, enc_power(pmax))
        w(b"\xC6\x41", pb, enc_power(pmin))
        w(b"\xC6\x42", pb, enc_power(pmax))
        w(b"\xCA\x06", pb, enc35(LAYER_COLORS[ly.kind]))
        w(b"\xCA\x41", pb, b"\x02" if ly.kind in SCAN_KINDS else b"\x00")  # work mode: 2 = scan/fill, 0 = vector
        w(b"\xE7\x52", pb, _pt(lx0, ly0))
        w(b"\xE7\x53", pb, _pt(lx1, ly1))
        w(b"\xE7\x61", pb, _pt(lx0, ly0))
        w(b"\xE7\x62", pb, _pt(lx1, ly1))
    w(b"\xCA\x22", bytes([len(layers) - 1]))  # max layer part
    w(b"\xE7\x54", b"\x00", enc35(0))  # pen offset x
    w(b"\xE7\x54", b"\x01", enc35(0))  # pen offset y
    w(b"\xE7\x55", b"\x00", enc35(0))  # layer offset x
    w(b"\xE7\x55", b"\x01", enc35(0))  # layer offset y
    w(b"\xF1\x03", _pt(0, 0))          # display offset
    # LightBurn also writes an ELEMENT_* block (F1 00 … F2 07) here. MeerK40t omits it, and so do we.
    # If the controller rejects our jobs, adding it back is the first thing to try.
    w(b"\xEA", b"\x00")                # array start
    w(b"\xE7\x60", b"\x00")            # current element index
    w(b"\xE7\x13", _pt(x0, y0))        # array min
    w(b"\xE7\x17", _pt(x1, y1))        # array max
    w(b"\xE7\x23", _pt(x0, y0))        # array add (LightBurn: the min corner)
    w(b"\xE7\x24", b"\x00")            # array mirror
    w(b"\xE7\x37", _pt(x1, y1))        # (LightBurn: the max corner)
    w(b"\xE7\x08", enc14(1), enc14(1), _pt(x1 - x0, y1 - y0))  # array repeat 1 × 1, unit = width × height

    # --- layers ---
    for part, ly in enumerate(layers):
        s = ly.settings
        pmin, pmax = powers(s)
        scan = ly.kind in SCAN_KINDS
        w(b"\xCA\x01\x01" if scan else b"\xCA\x01\x00")
        w(b"\xCA\x02", bytes([part]))                  # layer number
        w(b"\xCA\x01\x30")
        w(b"\xCA\x01\x10")                             # laser device 0
        w(b"\xCA\x01\x13" if s.air_assist else b"\xCA\x01\x12")
        w(b"\xC9\x02", enc_speed(s.speed_mm_s))
        if not scan:
            w(b"\xC6\x50", enc14(0))                   # through power 1
            w(b"\xC6\x51", enc14(0))                   # through power 2
        w(b"\xC6\x01", enc_power(pmin))
        w(b"\xC6\x02", enc_power(pmax))
        w(b"\xC6\x21", enc_power(pmin))
        w(b"\xC6\x22", enc_power(pmax))
        if scan:
            w(b"\xC6\x12", enc35(0))                   # laser on delay
            w(b"\xC6\x13", enc35(0))                   # laser off delay
        w(b"\xCA\x03", b"\x01")                        # enable laser tube start
        if not scan:
            w(b"\xCA\x10", b"\x00")
        for _ in range(s.passes):
            for poly in ly.paths:
                w.move(*poly[0])
                for pt in poly[1:]:
                    (w.cut if laser_on else w.move)(*pt)
        if scan:
            w(b"\xE7\x00")                             # LightBurn closes scan layers with a block end

    # --- tail ---
    w(b"\xEB")                                # array end
    w(b"\xE7\x00")                            # block end
    # LightBurn writes DA 01 06 20 … here (a controller variable). Omitted until we know what it is.
    w(b"\xE5\x05", enc35(sum(w.buf) + 0xD7))  # checksum over unswizzled bytes, verified on golden file
    w(b"\xD7")                                # end of file
    return swizzle(bytes(w.buf), m.swizzle_magic)


def frame_layers(bbox_mm: tuple[float, float, float, float], conv: Converter, settings: OpSettings) -> list[EncLayer]:
    """A single rectangle around the design, for encode_job(..., laser_on=False)."""
    x0, y0, x1, y1 = bbox_mm
    rect = [conv(x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0))]
    return [EncLayer("score", settings, [rect])]


STOP_PROCESS = b"\xD8\x01"
