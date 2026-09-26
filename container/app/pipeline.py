"""ContainerJob → ProcessResponse: import and place each part, map colours, validate, order, encode."""
from __future__ import annotations

import base64
import binascii
import math

from .geometry import ImportWarnings, Item, Pt
from .geometry.hatch import hatch
from .geometry.order import nearest_neighbour, order_cuts
from .geometry.transform import bbox, place
from .models import ContainerJob, OpKind, OpSettings, Part, PreviewLayer, ProcessResponse
from .ruida.encoder import EncLayer, clamp_settings, encode_job, frame_layers, machine_converter

LAYER_ORDER: tuple[OpKind, ...] = ("engrave", "score", "cut")
MAX_POINTS = 300_000
DEFAULT_HATCH_MM = 0.1
VERB = {"cut": "cut through", "score": "marked", "engrave": "engraved"}


def _import_part(job: ContainerJob, part: Part, n: int, warnings: ImportWarnings) -> list[Item]:
    """One part's Items in its own coordinates. Raises ValueError with a friendly message. `n` is 1-based."""
    if part.kind == "text":
        from .geometry.text_import import import_text
        try:
            return import_text(part.text, warnings)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"We couldn't make the text in \"part {n}\". Try different words.") from e
    if part.file_index >= len(job.files_b64):
        raise ValueError(f'The file for "part {n}" is missing. Try adding it again.')
    try:
        data = base64.b64decode(job.files_b64[part.file_index], validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f'The file for "part {n}" got damaged on upload. Try again.') from e
    try:
        if part.file_type == "svg":
            from .geometry.svg_import import import_svg
            return import_svg(data, warnings)
        from .geometry.dxf_import import import_dxf
        return import_dxf(data, warnings)
    except Exception as e:  # noqa: BLE001  (malformed files raise all sorts of things)
        raise ValueError(f"We couldn't read \"part {n}\" ({part.file_type.upper()}). Try exporting it again.") from e


def _place_part(items: list[Item], part: Part, first_group: int) -> tuple[list[Item], int]:
    """Scale and rotate, then put the part's top-right corner at (x_mm, y_mm). Uses every imported Item, so
    ignoring a colour later doesn't move the part. Engrave groups are renumbered from `first_group` so
    parts never share a fill group (None = the part's one shared group). Returns the next free group."""
    placed = place(items, part.model_copy(update={"x_mm": 0, "y_mm": 0}))
    _, _, w, _ = bbox(placed)
    dx, dy = part.x_mm - w, part.y_mm
    groups: dict[int | None, int] = {}
    out = []
    for it in placed:
        g = groups.setdefault(it.group, first_group + len(groups))
        out.append(Item(it.key, it.kind, [(x + dx, y + dy) for x, y in it.pts], it.closed, g))
    return out, first_group + len(groups)


def apply_power_choice(s: OpSettings, choice: float | None) -> OpSettings:
    """Student power within the teacher's range. Anything outside the range (or no range at all) is ignored."""
    if s.student_min_pct is None or s.student_max_pct is None:
        return s
    lo, hi = sorted((s.student_min_pct, s.student_max_pct))
    v = s.power_max_pct if choice is None else choice
    v = min(max(v, lo), hi)
    return s.model_copy(update={"power_min_pct": v, "power_max_pct": v})


def _length(p: list[Pt]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))


def estimate_seconds(layers: list[tuple[OpKind, OpSettings, list[list[Pt]]]], travel_mm_s: float) -> float:
    t = 0.0
    cur: Pt = (0.0, 0.0)
    for _, s, paths in layers:
        for _ in range(s.passes):
            for p in paths:
                t += math.hypot(p[0][0] - cur[0], p[0][1] - cur[1]) / travel_mm_s
                t += _length(p) / s.speed_mm_s + 0.01 * len(p)  # accel/corner overhead fudge
                cur = p[-1]
    return t


def process(job: ContainerJob) -> ProcessResponse:
    m, mat, req = job.machine, job.material, job.request
    res = ProcessResponse()
    warnings = ImportWarnings()

    # import and place each part
    items: list[tuple[int, Item]] = []
    next_group = 0
    for pi, part in enumerate(req.parts):
        try:
            got = _import_part(job, part, pi + 1, warnings)
        except ValueError as e:
            res.errors.append(str(e))
            continue
        if got:
            placed_part, next_group = _place_part(got, part, next_group)
            items += [(pi, it) for it in placed_part]
    if res.errors:
        res.warnings = list(warnings)
        return res

    # colour → op, honouring the student's answers
    kept: list[tuple[int, Item]] = []
    unknown: list[str] = []
    for pi, it in items:
        choice = req.color_map.get(it.key)
        if choice == "ignore":
            continue
        kind = choice or it.kind
        if kind is None:
            if it.key not in unknown:
                unknown.append(it.key)
            continue
        if kind not in mat.ops:
            warnings.add(f"{mat.name} can't be {VERB[kind]}, so those lines were skipped.")
            continue
        kept.append((pi, Item(it.key, kind, it.pts, it.closed, it.group)))
    res.unknown_colors = unknown
    res.warnings = list(warnings)
    boxes = []
    for pi in range(len(req.parts)):
        mine = [it for p, it in kept if p == pi]
        boxes.append(_round_box(bbox(mine)) if mine else None)
    res.part_boxes = boxes
    if unknown:
        res.errors.append("Choose what each colour should do.")
    if not kept:
        if not unknown:
            res.errors.append("Nothing to laser. Is the design empty?")
        return res
    if sum(len(i.pts) for _, i in kept) > MAX_POINTS:
        res.errors.append("This design is too detailed. Simplify it and try again.")
        return res

    x0, y0, x1, y1 = bbox([it for _, it in kept])
    if m.job_origin_mode == "relative":
        # The job starts wherever the laser head is, so only its size matters, not where it sits on the bed.
        if x1 - x0 > m.bed_width_mm or y1 - y0 > m.bed_height_mm:
            res.errors.append("The design is bigger than the laser bed. Make it smaller.")
    elif x0 < 0 or y0 < 0 or x1 > m.bed_width_mm or y1 > m.bed_height_mm:
        res.errors.append("The design goes off the edge of the laser bed. Move it or make it smaller.")
    res.bbox_mm = _round_box((x0, y0, x1, y1))

    # build toolpaths per op across the whole job, in cutting order; preview per (part, op)
    # Which part a path came from, even if ordering reversed it: every placed point is its own tuple object.
    owner = {id(pt): pi for pi, it in kept for pt in (it.pts[0], it.pts[-1])}
    layers: list[tuple[OpKind, OpSettings, list[list[Pt]]]] = []
    for kind in LAYER_ORDER:
        group = [(pi, i) for pi, i in kept if i.kind == kind]
        if not group:
            continue
        s = clamp_settings(apply_power_choice(mat.ops[kind], req.power_choice.get(kind)), m)
        if kind == "engrave":
            closed = [i for _, i in group if i.closed]
            if len(closed) < len(group):
                warnings.add("Open lines can't be filled, so they were skipped for engraving.")
            paths = hatch([i.pts for i in closed], s.hatch_mm or DEFAULT_HATCH_MM, [i.group for i in closed])
            shown = [i.pts for i in closed]
        elif kind == "score":
            paths = shown = nearest_neighbour([i.pts for _, i in group])
        else:
            paths = shown = order_cuts([i.pts for _, i in group])
        for pi in sorted({pi for pi, _ in group}):
            mine = [p for p in shown if owner[id(p[0])] == pi]
            res.preview.append(PreviewLayer(kind=kind, part=pi, paths=_round(mine)))
        if paths:
            layers.append((kind, s, paths))
    res.warnings = list(warnings)

    res.estimate_s = round(estimate_seconds(layers, m.travel_speed_mm_s), 1)
    if res.estimate_s > m.max_job_minutes * 60:
        res.errors.append(f"This would take about {res.estimate_s / 60:.0f} minutes. The limit is {m.max_job_minutes:.0f}. Make it smaller or simpler.")

    if res.errors or not layers:
        return res

    conv = machine_converter((x0, y0, x1, y1), m)
    enc = [EncLayer(k, s, [[conv(x, y) for x, y in p] for p in paths]) for k, s, paths in layers]
    res.rd = base64.b64encode(encode_job(enc, m)).decode()
    frame = frame_layers((x0, y0, x1, y1), conv, layers[0][1])
    res.frame_rd = base64.b64encode(encode_job(frame, m, laser_on=False)).decode()
    return res


def _round_box(b: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    return (round(b[0], 2), round(b[1], 2), round(b[2], 2), round(b[3], 2))


def _round(paths: list[list[Pt]]) -> list[list[tuple[float, float]]]:
    return [[(round(x, 2), round(y, 2)) for x, y in p] for p in paths]
