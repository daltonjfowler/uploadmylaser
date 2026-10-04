"""DWG -> DXF (beta) through LibreDWG's dwg2dxf (app/dwg.py). The refusals run everywhere; a real
conversion needs dwg2dxf, which only the container image has, so it is skipped elsewhere."""
import base64
import os

import pytest

from app import dwg
from app.dwg import DwgRequest, convert

b64 = lambda b: base64.b64encode(b).decode()


def test_not_a_dwg_is_refused(monkeypatch):
    monkeypatch.setattr(dwg, "DWG2DXF", "dwg2dxf")
    assert "not a DWG" in convert(DwgRequest(dwg_b64=b64(b"0\nSECTION\n"))).error


def test_damaged_upload_is_refused(monkeypatch):
    monkeypatch.setattr(dwg, "DWG2DXF", "dwg2dxf")
    assert "damaged" in convert(DwgRequest(dwg_b64="not base64!!")).error


def test_too_big_is_refused(monkeypatch):
    monkeypatch.setattr(dwg, "DWG2DXF", "dwg2dxf")
    monkeypatch.setattr(dwg, "MAX_DWG_BYTES", 10)
    assert "bigger than" in convert(DwgRequest(dwg_b64=b64(b"AC1027" + b"x" * 20))).error


def test_without_the_converter_it_says_save_as_dxf(monkeypatch):
    monkeypatch.setattr(dwg, "DWG2DXF", None)
    assert "Save As" in convert(DwgRequest(dwg_b64=b64(b"AC1027"))).error


def test_garbage_that_looks_like_a_dwg_fails_cleanly():
    if dwg.DWG2DXF is None:
        pytest.skip("dwg2dxf is only in the container image")
    out = convert(DwgRequest(dwg_b64=b64(b"AC1027" + os.urandom(4000))))
    assert out.dxf_b64 is None and "Save As" in out.error
