"""Text tool fonts: the picker (shared/contracts.ts TEXT_FONTS) and the container (text_import.FONTS) list the
same ids, and every font draws real, closed letters. Dalton 2026-11-12 asked for a ton more fonts."""
import os
import re
from pathlib import Path

import pytest

from app.geometry import ImportWarnings
from app.geometry import text_import
from app.models import TextSpec

CONTRACTS = Path(__file__).resolve().parents[2] / "shared" / "contracts.ts"
DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def picker_ids() -> list[str]:
    block = CONTRACTS.read_text(encoding="utf-8").split("export const TEXT_FONTS = [", 1)[1].split("] as const;", 1)[0]
    return re.findall(r"\{ id: '([a-z0-9-]+)'", block)


def test_picker_and_container_list_the_same_fonts():
    ids = picker_ids()
    assert len(ids) == len(set(ids)) >= 40
    assert set(ids) == set(text_import.FONTS)


def test_every_downloaded_font_is_hash_checked_in_the_dockerfile():
    if not DOCKERFILE.exists():
        pytest.skip("run from the repository (the image has no Dockerfile)")
    docker = DOCKERFILE.read_text(encoding="utf-8")
    for path in text_import.FONTS.values():
        if "/uml/" in path:
            name = os.path.basename(path)
            assert f"/{name} \\" in docker, name  # downloaded
            assert re.search(rf"'[0-9a-f]{{64}}  {re.escape(name)}'", docker), name  # and checked


def test_stencils_and_messy_fonts_are_known_ids():
    assert text_import.STENCILS <= set(text_import.FONTS)
    assert text_import.CUT_UNFRIENDLY <= set(text_import.FONTS)
    assert not text_import.STENCILS & text_import.CUT_UNFRIENDLY


@pytest.mark.parametrize("font", sorted(text_import.FONTS))
def test_every_font_draws_closed_letters(font):
    if not os.path.exists(text_import.FONTS[font]):
        pytest.skip("fonts are installed in the container image")
    w = ImportWarnings()
    items = text_import.import_text(TextSpec(value="Ab 8?", font=font, height_mm=20, op="engrave"), w)
    assert items and all(it.closed for it in items), font
    ys = [y for it in items for _, y in it.pts]
    assert 15 < max(ys) - min(ys) < 60, (font, max(ys) - min(ys))  # 20 mm capitals, plus a descender
    assert not any("isn't available" in x or "has no" in x for x in w), (font, list(w))
