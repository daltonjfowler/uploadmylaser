"""Pydantic mirror of shared/contracts.ts. Keep the two files in sync."""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

OpKind = Literal["cut", "score", "engrave"]
ColorChoice = Literal["cut", "score", "engrave", "ignore"]
Origin = Literal["top-left", "top-right", "bottom-left", "bottom-right"]


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class OpSettings(_Camel):
    speed_mm_s: float = Field(gt=0)
    power_min_pct: float = Field(ge=0, le=100)
    power_max_pct: float = Field(ge=0, le=100)
    passes: int = Field(default=1, ge=1, le=10)
    hatch_mm: Optional[float] = Field(default=None, gt=0)
    air_assist: bool = True
    # If both are set, students may choose this op's power within [student_min_pct, student_max_pct].
    # Default is power_max_pct. Still capped by MachineConfig.absolute_max_power_pct.
    student_min_pct: Optional[float] = Field(default=None, ge=0, le=100)
    student_max_pct: Optional[float] = Field(default=None, ge=0, le=100)


class Material(_Camel):
    id: str
    name: str
    thickness_mm: float
    enabled: bool = True
    ops: dict[OpKind, OpSettings]


class MachineConfig(_Camel):
    bed_width_mm: float = 914.0   # LS-3655: 36" x 24". Verify in Phase 0.
    bed_height_mm: float = 609.0
    origin: Origin = "top-right"
    # relative: the job's corner matching `origin` (top-right) starts wherever the laser head is (D8 11, like
    #           the class nameplate file). absolute: design sits at its bed X/Y (D8 10 + E6 01).
    job_origin_mode: Literal["relative", "absolute"] = "relative"
    swizzle_magic: int = 0x88
    baud: int = 115200
    max_job_minutes: float = 30.0
    absolute_max_power_pct: float = 80.0
    min_speed_mm_s: float = 2.0
    travel_speed_mm_s: float = 300.0  # only used for time estimates
    send_to_panel: bool = False  # browser only: Send names the job on the panel (web/src/ruida/panel.ts)


class Placement(_Camel):
    """Bed mm, top-left origin. The part is scaled and rotated, then its top-right corner goes at (x_mm, y_mm)."""
    x_mm: float = 10.0
    y_mm: float = 10.0
    scale: float = Field(default=1.0, gt=0, le=20)
    scale_y: Optional[float] = Field(default=None, gt=0, le=20)  # stretched height; None = scale
    rotate_deg: Literal[0, 90, 180, 270] = 0
    flip_x: bool = False  # mirrored in the part's own frame, before rotation
    flip_y: bool = False


class OutlineSpec(_Camel):
    dist_mm: float = Field(ge=0.5, le=20)
    hole_mm: float = Field(default=0.0, ge=0, le=12)


class TextSpec(_Camel):
    value: str = Field(min_length=1, max_length=120)  # up to 4 lines
    font: str = "sans"
    height_mm: float = Field(default=15.0, ge=1, le=200)  # the Worker allows 1 mm too
    op: OpKind = "engrave"


class FilePart(Placement):
    weld: bool = False
    close_gaps: bool = False  # weld open ends closed, so open shapes can be engraved
    outline: Optional[OutlineSpec] = None
    kind: Literal["file"] = "file"
    file_index: int = Field(ge=0)
    file_type: Literal["svg", "dxf", "pbm"]  # pbm: a photo, already black and white dots
    color_map: dict[str, ColorChoice] = {}  # this file's own choices, ahead of ProcessRequest.color_map
    dxf_units: Optional[Literal[1, 2, 4, 5, 6]] = None  # "I drew in" ($INSUNITS code), ahead of the file's own


class TextPart(Placement):
    weld: bool = False
    close_gaps: bool = False
    outline: Optional[OutlineSpec] = None
    kind: Literal["text"] = "text"
    text: TextSpec


Part = Annotated[Union[FilePart, TextPart], Field(discriminator="kind")]
MAX_PARTS = 5000


class ProcessRequest(_Camel):
    material_id: str
    parts: list[Part] = Field(min_length=1, max_length=MAX_PARTS)
    color_map: dict[str, ColorChoice] = {}
    power_choice: dict[OpKind, float] = {}  # only honoured for ops with a student range
    join_lines: bool = True  # chain touching lines into single paths and drop repeats (cut and mark)


class ContainerJob(_Camel):
    """What the Worker sends the container: the student request plus server-resolved settings."""
    request: ProcessRequest
    material: Material
    machine: MachineConfig
    files_b64: list[str] = []  # index = FilePart.file_index


class PreviewLayer(_Camel):
    kind: OpKind
    part: int
    paths: list[list[tuple[float, float]]]


class PartPaths(_Camel):
    part: int
    paths: list[list[tuple[float, float]]]


class PartColor(_Camel):
    part: int
    key: str
    kind: Optional[OpKind]  # what the file itself makes it; None = the student has to choose


class ProcessResponse(_Camel):
    preview: list[PreviewLayer] = []
    unassigned: list[PartPaths] = []  # lines whose colour the student hasn't chosen yet, per part
    part_boxes: list[Optional[tuple[float, float, float, float]]] = []  # one per request part
    bbox_mm: Optional[tuple[float, float, float, float]] = None
    rd: Optional[str] = None
    frame_rd: Optional[str] = None
    estimate_s: float = 0.0
    unknown_colors: list[str] = []
    part_colors: list[PartColor] = []  # every colour in every file part, for the colour list
    warnings: list[str] = []
    errors: list[str] = []
    open_engrave_parts: list[int] = []  # parts with open lines that engraving had to skip
