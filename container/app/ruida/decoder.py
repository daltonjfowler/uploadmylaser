"""Decode .rd bytes into readable commands — for tests, golden-file diffs, and debugging.

    python -m app.ruida.decoder test/golden/square.rd [--magic 0x88]

Every command starts with a byte >= 0x80 and its data bytes are < 0x80, so tokenising is just
"split before each high-bit byte". Names cover the commands our encoder emits plus common extras.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

from .swizzle import unswizzle

NAMES: dict[bytes, str] = {
    b"\x88": "MOVE_ABS", b"\x89": "MOVE_REL", b"\x8A": "MOVE_REL_X", b"\x8B": "MOVE_REL_Y",
    b"\xA8": "CUT_ABS", b"\xA9": "CUT_REL", b"\xAA": "CUT_REL_X", b"\xAB": "CUT_REL_Y",
    b"\xC6\x01": "MIN_POWER_1", b"\xC6\x02": "MAX_POWER_1", b"\xC6\x21": "MIN_POWER_2", b"\xC6\x22": "MAX_POWER_2",
    b"\xC6\x31": "MIN_POWER_1_PART", b"\xC6\x32": "MAX_POWER_1_PART",
    b"\xC6\x41": "MIN_POWER_2_PART", b"\xC6\x42": "MAX_POWER_2_PART",
    b"\xC6\x12": "LASER_ON_DELAY", b"\xC6\x13": "LASER_OFF_DELAY", b"\xC6\x60": "FREQUENCY_PART",
    b"\xC9\x02": "SPEED_LASER_1", b"\xC9\x04": "SPEED_LASER_1_PART",
    b"\xCA\x01": "LAYER_FLAG", b"\xCA\x02": "LAYER_NUMBER_PART", b"\xCA\x03": "EN_LASER_TUBE_START",
    b"\xCA\x06": "LAYER_COLOR_PART", b"\xCA\x22": "MAX_LAYER_PART", b"\xCA\x41": "WORK_MODE_PART",
    b"\xD7": "END_OF_FILE", b"\xD8\x00": "START_PROCESS", b"\xD8\x01": "STOP_PROCESS",
    b"\xD8\x10": "REF_POINT_2", b"\xD8\x11": "REF_POINT_1", b"\xD8\x12": "REF_POINT_0",
    b"\xE5\x05": "SET_FILE_SUM", b"\xE6\x01": "SET_ABSOLUTE",
    b"\xE7\x00": "BLOCK_END", b"\xE7\x01": "SET_FILENAME", b"\xE7\x03": "PROCESS_TOP_LEFT",
    b"\xE7\x04": "PROCESS_REPEAT", b"\xE7\x05": "ARRAY_DIRECTION", b"\xE7\x06": "FEED_REPEAT",
    b"\xE7\x07": "PROCESS_BOTTOM_RIGHT", b"\xE7\x08": "ARRAY_REPEAT", b"\xE7\x0A": "FEED_INFO",
    b"\xE7\x0B": "ARRAY_EN_MIRROR_CUT", b"\xE7\x13": "ARRAY_MIN_POINT", b"\xE7\x17": "ARRAY_MAX_POINT",
    b"\xE7\x23": "ARRAY_ADD", b"\xE7\x24": "ARRAY_MIRROR", b"\xE7\x38": "SET_FEED_AUTO_PAUSE",
    b"\xE7\x50": "DOCUMENT_MIN_POINT", b"\xE7\x51": "DOCUMENT_MAX_POINT",
    b"\xE7\x52": "PART_MIN_POINT", b"\xE7\x53": "PART_MAX_POINT", b"\xE7\x54": "PEN_OFFSET",
    b"\xE7\x55": "LAYER_OFFSET", b"\xE7\x60": "SET_CURRENT_ELEMENT_INDEX",
    b"\xE7\x61": "PART_MIN_POINT_EX", b"\xE7\x62": "PART_MAX_POINT_EX",
    b"\xEA": "ARRAY_START", b"\xEB": "ARRAY_END", b"\xF0": "REF_POINT_SET",
    b"\xF1\x02": "ENABLE_BLOCK_CUTTING", b"\xF1\x03": "DISPLAY_OFFSET",
    # seen in LightBurn output for the RDC6445S
    b"\xC6\x50": "THROUGH_POWER_1", b"\xC6\x51": "THROUGH_POWER_2", b"\xCA\x10": "LAYER_CA10",
    b"\xE7\x37": "ARRAY_UNIT_SIZE", b"\xDA\x01": "SET_VARIABLE",
    b"\xF1\x00": "ELEMENT_MAX_INDEX", b"\xF1\x01": "ELEMENT_NAME_MAX_INDEX",
    b"\xF2\x00": "ELEMENT_INDEX", b"\xF2\x01": "ELEMENT_F201", b"\xF2\x02": "ELEMENT_NAME",
    b"\xF2\x03": "ELEMENT_ARRAY_MIN_POINT", b"\xF2\x04": "ELEMENT_ARRAY_MAX_POINT", b"\xF2\x05": "ELEMENT_ARRAY",
    b"\xF2\x06": "ELEMENT_ARRAY_ADD", b"\xF2\x07": "ELEMENT_ARRAY_MIRROR",
}


@dataclass
class RdCommand:
    raw: bytes
    name: str

    @property
    def data(self) -> bytes:
        key = self.raw[:2] if self.raw[:2] in NAMES else self.raw[:1]
        return self.raw[len(key):]

    def __str__(self) -> str:
        return f"{self.name:<26} {self.raw.hex(' ')}"


def tokenize(plain: bytes) -> list[bytes]:
    out: list[bytearray] = []
    for b in plain:
        if b & 0x80 or not out:
            out.append(bytearray([b]))
        else:
            out[-1].append(b)
    return [bytes(t) for t in out]


def decode_plain(plain: bytes) -> list[RdCommand]:
    cmds = []
    for t in tokenize(plain):
        name = NAMES.get(t[:2]) or NAMES.get(t[:1]) or f"UNKNOWN_{t[:2].hex()}"
        cmds.append(RdCommand(t, name))
    return cmds


def decode_rd(data: bytes, magic: int = 0x88) -> list[RdCommand]:
    return decode_plain(unswizzle(data, magic))


def dec14(b: bytes, signed: bool = True) -> int:
    """Relative moves are signed. Power (a fraction of 16383) is not."""
    v = (b[0] << 7) | b[1]
    return v - 0x4000 if signed and v & 0x2000 else v


def dec35(b: bytes) -> int:
    v = 0
    for x in b[:5]:
        v = (v << 7) | x
    return v


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--magic", default="0x88")
    a = ap.parse_args(argv)
    with open(a.file, "rb") as f:
        for c in decode_rd(f.read(), int(a.magic, 0)):
            print(c)


if __name__ == "__main__":
    main(sys.argv[1:])
