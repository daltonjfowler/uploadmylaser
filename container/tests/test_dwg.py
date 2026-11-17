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


def _dxf_with_texts(*texts: str) -> bytes:
    import io

    import ezdxf
    doc = ezdxf.new("R2018")
    for k, t in enumerate(texts):
        doc.modelspace().add_mtext(t, dxfattribs={"insert": (0, k * 10)})
    doc.modelspace().add_line((0, 0), (5, 5))
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().replace("\n", "\r\n").encode()


@pytest.mark.parametrize("after", [b"", b"ROUND", b"51"])
def test_line_break_inside_text_is_mended(after):
    """dwg2dxf wrote multi-line MTEXT ("MYSTERY / CARD") with a real line break, so the DXF could not be
    read at all (Dalton 2026-11-17, a student's board game). A numeric second line ("AREA / 51") too."""
    from app.geometry import ImportWarnings
    from app.geometry.dxf_import import import_dxf

    good = _dxf_with_texts("MYSTERY^JCARD", "AREA")
    broken = good.replace(b"MYSTERY^JCARD\r\n", b"MYSTERY^JCARD\r\n" + after + b"\r\n", 1)
    broken = broken.replace(b"AREA\r\n", b"AREA\r\n51\r\n", 1)
    assert broken != good
    with pytest.raises(Exception):
        import_dxf(broken, ImportWarnings())  # what the site did before: nothing could be read
    fixed = dwg.mend_text_breaks(broken)
    items = import_dxf(fixed, ImportWarnings())
    assert len(items) > 10  # the letters and the line
    assert b"MYSTERY^JCARD " + after in fixed and b"AREA 51" in fixed


def test_a_good_dxf_is_left_alone():
    good = _dxf_with_texts("ONE", "TWO\\PLINES")
    assert dwg.mend_text_breaks(good) is good


def test_garbage_that_looks_like_a_dwg_fails_cleanly():
    if dwg.DWG2DXF is None:
        pytest.skip("dwg2dxf is only in the container image")
    out = convert(DwgRequest(dwg_b64=b64(b"AC1027" + os.urandom(4000))))
    assert out.dxf_b64 is None and "Save As" in out.error
