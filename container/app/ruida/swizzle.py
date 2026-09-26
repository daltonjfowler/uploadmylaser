"""Ruida byte obfuscation. Algorithm from MeerK40t (MIT) / EduTech wiki.

The magic depends on the controller family: 0x88 for RDC644xG (expected on the LS36), 0x11 for 634xG.
"""


def swizzle_byte(b: int, magic: int) -> int:
    b ^= (b >> 7) & 0xFF
    b ^= (b << 7) & 0xFF
    b ^= (b >> 7) & 0xFF
    b ^= magic
    return (b + 1) & 0xFF


def unswizzle_byte(b: int, magic: int) -> int:
    b = (b - 1) & 0xFF
    b ^= magic
    b ^= (b >> 7) & 0xFF
    b ^= (b << 7) & 0xFF
    b ^= (b >> 7) & 0xFF
    return b


def _luts(magic: int) -> tuple[bytes, bytes]:
    return (
        bytes(swizzle_byte(i, magic) for i in range(256)),
        bytes(unswizzle_byte(i, magic) for i in range(256)),
    )


def swizzle(data: bytes, magic: int = 0x88) -> bytes:
    return data.translate(_luts(magic)[0])


def unswizzle(data: bytes, magic: int = 0x88) -> bytes:
    return data.translate(_luts(magic)[1])
