"""DWG -> DXF with LibreDWG's dwg2dxf (GPL-3.0, run as a separate program; see CREDITS.md). Beta.

DWG is AutoCAD's closed format. LibreDWG reads most 2D drawings from R13 to 2018, but not all of them,
so the page always says it is a beta and that Save As DXF in AutoCAD is the sure way. The DXF that
comes back is imported exactly like one the student picked, so nothing else changes.

One conversion at a time, in a temp folder that is deleted afterwards, with a time limit and (on
Linux) a memory and CPU cap: one container serves the whole school.
"""
from __future__ import annotations

import base64
import binascii
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional

from pydantic import Field

from .models import _Camel

MAX_DWG_BYTES = 10 * 1024 * 1024
MAX_DXF_BYTES = 10 * 1024 * 1024  # the page takes 10 MB of files per design (MAX_UPLOAD_BYTES)
TIME_LIMIT_S = 20.0  # under the Worker's 30 s
# 2 job workers x 512 MB (runner.py) + this must fit the ~1 GiB basic instance as far as possible
MEMORY_LIMIT_BYTES = 384 * 1024 * 1024
DWG2DXF = shutil.which("dwg2dxf")

SAVE_AS = "In AutoCAD, use Save As and pick \"AutoCAD 2013 DXF\", then import that file."
_one = threading.Semaphore(1)


class DwgRequest(_Camel):
    dwg_b64: str = Field(max_length=MAX_DWG_BYTES * 4 // 3 + 8)


class DwgResponse(_Camel):
    dxf_b64: Optional[str] = None
    error: Optional[str] = None


# prlimit (util-linux, in the image) caps the converter's memory and CPU; preexec_fn is not safe
# here because FastAPI runs requests on threads. A Windows dev box runs it uncapped.
PRLIMIT = shutil.which("prlimit")


def _command(src: Path, out: Path) -> list[str]:
    cmd = [str(DWG2DXF), "-y", "-o", str(out), str(src)]
    return [PRLIMIT, f"--as={MEMORY_LIMIT_BYTES}", "--cpu=30", "--", *cmd] if PRLIMIT else cmd


def convert(req: DwgRequest) -> DwgResponse:
    if DWG2DXF is None:
        return DwgResponse(error="DWG files cannot be opened here yet. " + SAVE_AS)
    try:
        data = base64.b64decode(req.dwg_b64, validate=True)
    except (binascii.Error, ValueError):
        return DwgResponse(error="That DWG got damaged on upload. Try again.")
    if len(data) > MAX_DWG_BYTES:
        return DwgResponse(error=f"That DWG is bigger than {MAX_DWG_BYTES // 1024 // 1024} MB. " + SAVE_AS)
    if not data.startswith(b"AC10") and not data.startswith(b"AC1."):
        return DwgResponse(error="That file is not a DWG. Pick a DWG, DXF or SVG file.")
    if not _one.acquire(timeout=TIME_LIMIT_S):
        return DwgResponse(error="The laser processor is busy converting another DWG. Try again in a few seconds.")
    try:
        with tempfile.TemporaryDirectory(prefix="dwg-") as tmp:
            src, out = Path(tmp, "in.dwg"), Path(tmp, "out.dxf")
            src.write_bytes(data)
            try:
                subprocess.run(_command(src, out), cwd=tmp, timeout=TIME_LIMIT_S, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            except subprocess.TimeoutExpired:
                return DwgResponse(error="That DWG took too long to convert. " + SAVE_AS)
            # dwg2dxf reports small problems through its exit code too, so judge by what it wrote.
            if not out.exists() or out.stat().st_size == 0:
                return DwgResponse(error="That DWG could not be converted. " + SAVE_AS)
            if out.stat().st_size > MAX_DXF_BYTES:
                return DwgResponse(error="That DWG is too big once converted. " + SAVE_AS)
            dxf = out.read_bytes()
            if b"EOF" not in dxf[-64:]:
                return DwgResponse(error="That DWG only partly converted. " + SAVE_AS)
            return DwgResponse(dxf_b64=base64.b64encode(dxf).decode())
    finally:
        _one.release()
