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


class TextSpec(_Camel):
    value: str = Field(min_length=1, max_length=60)
    font: str = "sans"
    height_mm: float = Field(default=15.0, gt=1, le=200)
    op: OpKind = "engrave"


class FilePart(Placement):
    kind: Literal["file"] = "file"
    file_index: int = Field(ge=0)
    file_type: Literal["svg", "dxf"]


class TextPart(Placement):
    kind: Literal["text"] = "text"
    text: TextSpec


Part = Annotated[Union[FilePart, TextPart], Field(discriminator="kind")]
MAX_PARTS = 100


class ProcessRequest(_Camel):
    material_id: str
    parts: list[Part] = Field(min_length=1, max_length=MAX_PARTS)
    color_map: dict[str, ColorChoice] = {}
    power_choice: dict[OpKind, float] = {}  # only honoured for ops with a student range


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


class ProcessResponse(_Camel):
    preview: list[PreviewLayer] = []
    part_boxes: list[Optional[tuple[float, float, float, float]]] = []  # one per request part
    bbox_mm: Optional[tuple[float, float, float, float]] = None
    rd: Optional[str] = None
    frame_rd: Optional[str] = None
    estimate_s: float = 0.0
    unknown_colors: list[str] = []
    warnings: list[str] = []
    errors: list[str] = []
