"""Pydantic schemas for slice requests."""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# ``#RRGGBB`` or ``#RRGGBBAA`` — the two spellings BambuStudio / OrcaSlicer
# write into ``filament_colour``. 3MFs carry the 8-digit form.
_HEX_COLOUR_RE = re.compile(r"#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?")


class PresetRef(BaseModel):
    """A source-aware reference to a printer / process / filament preset.

    The SliceModal pulls dropdown options from four tiers (orca_cloud /
    cloud / local / standard). At submit time the client sends one of these
    per slot so the backend knows where to fetch the preset content from at
    slice time. ``cloud`` is Bambu Cloud (kept as the bare name for backward
    compatibility with existing requests); ``orca_cloud`` is Orca Cloud.
    """

    source: Literal["orca_cloud", "cloud", "local", "standard"]
    id: str = Field(
        ...,
        description=(
            "Orca Cloud profile id, Bambu Cloud setting_id, local DB row id (stringified), or standard preset name."
        ),
    )


class SliceRequest(BaseModel):
    """Body for `POST /library/files/{file_id}/slice`.

    Two preset shapes are accepted per slot for backwards-compatibility:

    - **Legacy** — bare integer ``*_preset_id`` fields point into the
      ``local_presets`` table. Existing clients (and stale browser tabs after
      a Bambuddy upgrade) keep working unchanged.
    - **Source-aware** — ``*_preset`` carries an explicit
      ``{source, id}``. Required for cloud / standard tiers; also accepted
      (and equivalent) for local presets when the client is on the new modal.

    Exactly one of each pair must be set; the validator normalises legacy
    integer ids into a ``PresetRef(source='local', id=str(id))`` so the
    downstream resolver only deals with one shape.
    """

    # Legacy fields — kept optional so older clients continue to work.
    printer_preset_id: int | None = Field(
        default=None,
        description="DEPRECATED: prefer printer_preset. LocalPreset id with preset_type='printer'.",
    )
    process_preset_id: int | None = Field(
        default=None,
        description="DEPRECATED: prefer process_preset. LocalPreset id with preset_type='process'.",
    )
    filament_preset_id: int | None = Field(
        default=None,
        description="DEPRECATED: prefer filament_preset. LocalPreset id with preset_type='filament'.",
    )

    # Source-aware fields — set by the new SliceModal.
    printer_preset: PresetRef | None = None
    process_preset: PresetRef | None = None
    filament_preset: PresetRef | None = None

    # Multi-color: one PresetRef per AMS slot the source plate uses. Order is
    # significant — the slicer matches index-by-index against the plate's
    # filament slots. Always preferred over the legacy singular field; the
    # validator promotes a singular field into ``[singular]`` when the list
    # is empty so older clients keep working.
    filament_presets: list[PresetRef] = Field(default_factory=list)

    # Per-slot filament colour overrides (#45), positionally aligned with
    # ``filament_presets``: entry i colours slot i + 1. ``None`` in a position
    # leaves that slot's profile colour untouched, and an omitted / empty list
    # leaves every slot alone — so a client that never offers the control
    # sends exactly what it sent before this field existed.
    #
    # Colour is a filament-profile property (``filament_colour``), not a
    # process one, so it cannot ride along in ``process_overrides``. It matters
    # beyond decoration: the produced 3MF carries the colours, which is what
    # the printer's own slot mapping and Bambuddy's 3D view read.
    filament_colours: list[str | None] = Field(
        default_factory=list,
        description=(
            "Per-slot filament colour overrides, aligned index-by-index with "
            "'filament_presets' (index 0 = slot 1). Each entry is a '#RRGGBB' / "
            "'#RRGGBBAA' hex colour, or null to leave that slot's profile colour "
            "alone. Omit for a slice that keeps every profile's own colour. "
            "Entries past the end of 'filament_presets' are ignored."
        ),
    )

    plate: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Plate number to slice. ``None`` defaults to plate 1 on the sidecar "
            "(matches the pre-multi-plate behaviour). ``0`` is the sidecar's "
            "'all plates' sentinel — produces a single multi-plate 3MF whose "
            "``Metadata/plate_N.gcode`` entries cover every plate in the "
            "source. ``>= 1`` slices that one plate."
        ),
    )
    export_3mf: bool = Field(
        default=False,
        description="If true, request a 3MF response with embedded G-code instead of raw G-code.",
    )
    use_embedded_settings: bool = Field(
        default=False,
        description=(
            "3MF only. Slice using the file's embedded "
            "``Metadata/project_settings.config`` (the designer's own tweaks — wall "
            "count, infill, etc.) instead of the picked printer/process/filament "
            "triplet. This is the 'slice as designed' path: no ``--load-settings`` "
            "override, so a MakerWorld author's settings survive. Ignored for STL / "
            "plain-model 3MF (no embedded profile to honour). The preset refs are "
            "still required by the validator but go unused on this path. Only makes "
            "sense when the picked printer matches the design's target model — the "
            "UI gates the toggle on that; there is no cross-printer re-targeting here "
            "(that is exactly what the profile path is for)."
        ),
    )
    bed_type: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Override the process preset's curr_bed_type for this slice. Canonical "
            "BambuStudio / OrcaSlicer values: 'Cool Plate', 'Engineering Plate', "
            "'High Temp Plate', 'Textured PEI Plate', 'Smooth PEI Plate', "
            "'Cool Plate (SuperTack)', 'Supertack Plate'. None ⇒ inherit from the "
            "process preset unchanged (#1337)."
        ),
    )
    process_overrides: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Per-slice print-setting overrides, patched onto the resolved process "
            "profile before it reaches the slicer, so a user can change individual "
            "settings for one slice without cloning a preset. Keys are slicer "
            "setting names as the CLI spells them (e.g. 'sparse_infill_density'). "
            "``bed_type`` above stays a field of its own and wins over a "
            "``curr_bed_type`` supplied here."
        ),
    )

    @field_validator("filament_colours")
    @classmethod
    def validate_filament_colours(cls, value: list[str | None]) -> list[str | None]:
        """Reject anything that isn't a hex colour, rather than writing it into
        a filament profile and finding out at slice time.

        The slicer reads ``filament_colour`` as ``#RRGGBB`` / ``#RRGGBBAA``; a
        value it can't parse is either ignored (so the user's pick silently does
        nothing) or trips the CLI's own config validation with a message that
        names the profile rather than the request. A 422 here says which slot.
        """
        out: list[str | None] = []
        for index, colour in enumerate(value):
            if colour is None:
                out.append(None)
                continue
            normalised = colour.strip()
            if not _HEX_COLOUR_RE.fullmatch(normalised):
                raise ValueError(
                    f"filament_colours[{index}] must be a '#RRGGBB' or '#RRGGBBAA' hex colour (got {colour!r})"
                )
            out.append(normalised)
        return out

    @model_validator(mode="after")
    def normalise_preset_refs(self) -> "SliceRequest":
        """Each slot must end up with a `PresetRef` set. Legacy integer ids
        become `(source='local', id=str(int))` so the route handler only
        deals with the canonical shape. For filament: a non-empty
        ``filament_presets`` list satisfies the requirement on its own; an
        empty list falls back to the singular fields, which then promote
        into a one-element list.
        """
        for slot, ref_attr, legacy_attr in (
            ("printer", "printer_preset", "printer_preset_id"),
            ("process", "process_preset", "process_preset_id"),
        ):
            ref = getattr(self, ref_attr)
            legacy_id = getattr(self, legacy_attr)
            if ref is None and legacy_id is None:
                raise ValueError(
                    f"{slot} preset is required: provide '{ref_attr}' (preferred) or legacy '{legacy_attr}'"
                )
            if ref is None:
                setattr(self, ref_attr, PresetRef(source="local", id=str(legacy_id)))

        # Filament accepts THREE shapes, in priority order:
        #   1. filament_presets    — multi-color array (new clients)
        #   2. filament_preset     — source-aware singular (single-color new clients)
        #   3. filament_preset_id  — legacy bare integer (old clients)
        # The first non-empty shape wins; missing all three raises.
        if not self.filament_presets:
            if self.filament_preset is not None:
                self.filament_presets = [self.filament_preset]
            elif self.filament_preset_id is not None:
                fallback = PresetRef(source="local", id=str(self.filament_preset_id))
                self.filament_preset = fallback
                self.filament_presets = [fallback]
            else:
                raise ValueError(
                    "filament preset is required: provide 'filament_presets' (preferred), "
                    "'filament_preset', or legacy 'filament_preset_id'"
                )
        elif self.filament_preset is None:
            # Multi-color caller: backfill the singular from the first slot
            # so callers that still read the legacy field see a stable value.
            self.filament_preset = self.filament_presets[0]
        return self


class SliceResponse(BaseModel):
    """Response from `POST /library/files/{file_id}/slice`. The result lands
    in the user's library as a new ``LibraryFile`` (in the same folder as
    the source)."""

    library_file_id: int
    name: str
    print_time_seconds: int
    filament_used_g: float
    filament_used_mm: float
    used_embedded_settings: bool = False


class SliceArchiveResponse(BaseModel):
    """Response from `POST /archives/{archive_id}/slice`. The result lands
    in the user's archives as a new ``PrintArchive`` row, inheriting
    printer / project metadata from the source archive."""

    archive_id: int
    name: str
    print_time_seconds: int
    filament_used_g: float
    filament_used_mm: float
    used_embedded_settings: bool = False
