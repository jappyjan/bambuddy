export interface PlateFilament {
  slot_id: number;
  type: string;
  color: string;
  used_grams: number;
  used_meters: number;
  // True when this AMS slot is consumed by the picked plate. False
  // means the slot is configured project-wide but the picked plate
  // doesn't paint with it. Sliced 3MFs (.gcode.3mf) report only used
  // filaments — the field is true for every entry. Unsliced project
  // files report ALL project slots; SliceModal disables the unused
  // rows so the user only interacts with the dropdowns that matter,
  // while the backend still passes the complete list to the slicer
  // CLI to prevent silent fallback to embedded defaults.
  used_in_plate?: boolean;
}

export interface PlateMetadata {
  index: number;
  name: string | null;
  /**
   * Display **names** of the objects on this plate ("part_0.stl"), read from
   * `slice_info.config` / `plate_*.json`. Shown in the file grid and used as a
   * fallback plate name. **Not** ids — see `object_ids`.
   */
  objects: string[];
  /**
   * The 3MF `<object id>` values for this plate, in `model_settings.config`
   * order. This is what `ModelViewer` parses into `ObjectData.id`, what the
   * saved `plate_layout` keys placements on, and the only thing the backend's
   * placement applier can match — a name in that field is accepted, stored and
   * then silently dropped at slice time (step-8 / #32).
   *
   * Absent on older backends and on 3MFs whose object ids cannot be
   * determined; the stage then has nothing safe to move and stays read-only.
   */
  object_ids?: string[];
  object_count?: number;
  has_thumbnail: boolean;
  thumbnail_url: string | null;
  print_time_seconds: number | null;
  filament_used_grams: number | null;
  filaments: PlateFilament[];
  // Per-plate build plate type so multi-plate prints can show the right
  // plate at scheduling time (#1281). Falls back to null for older 3MFs
  // that don't carry curr_bed_type in slice_info.config.
  bed_type?: string | null;
}

// Printer / process preset names the source 3MF was prepared with, read from
// its project_settings.config. Used by the SliceModal to default its printer
// and process dropdowns (#1325). Null / absent when the file carries no
// embedded slicer config (STL, plain model 3MF, parse failure).
interface EmbeddedPresets {
  embedded_printer?: string | null;
  embedded_process?: string | null;
}

export interface ArchivePlatesResponse extends EmbeddedPresets {
  archive_id: number;
  filename: string;
  plates: PlateMetadata[];
  is_multi_plate: boolean;
  has_gcode?: boolean;
}

export interface LibraryFilePlatesResponse extends EmbeddedPresets {
  file_id: number;
  filename: string;
  plates: PlateMetadata[];
  is_multi_plate: boolean;
}

export interface ViewerPlateSelectionState {
  selected_plate_id: number | null;
}

export interface PlateAssignment {
  object_id: string;
  plate_id: number | null;
}
