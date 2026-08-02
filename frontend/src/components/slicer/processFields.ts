/**
 * Types and pure helpers for the per-slice process override editor
 * (slicer UX redesign, spec §5 + §6 — ticket #13 / step-5.1).
 *
 * Everything here is side-effect free so the override diff can be reasoned
 * about — and tested — without rendering anything. `ProcessSettingsEditor`
 * is the only UI in this feature that decides what gets sent to the slicer,
 * and the rule it exists to enforce lives in `nextOverrides()`:
 *
 *   **a field set back to its resolved default contributes nothing at all.**
 *
 * That is not a nicety. `process_overrides` is patched into the resolved
 * process JSON before dispatch, so a no-op entry is indistinguishable from a
 * deliberate one at every later stage: it invalidates "Print now" (#15), it
 * shows up as a change the user has to reason about, and it makes two
 * identical slices look different. Dropping it here is the only place it can
 * be dropped with knowledge of what the default actually was.
 *
 * ## Wire shapes
 *
 * `GET /slicer/process-fields` returns curated metadata, already filtered to
 * the keys the configured slicer really has:
 *
 *     { "slicer": "bambu_studio", "fields": [ { key, label, type, ... } ] }
 *
 * `GET /slicer/resolved-process?source=…&id=…` returns the raw resolved
 * profile. Real process profiles spell **every** value as a string, or as a
 * list of strings for per-extruder settings — `"0.2"`, `"20%"`, `"1"`,
 * `["0.42"]`. `parseResolvedValue()` is what turns that back into the typed
 * value a control can hold; `backend/app/services/process_overrides.py`
 * `_coerce()` does the inverse on the way out, which is why the diff carries
 * native `number` / `boolean` / `string` and not profile spellings.
 */

/** Control kind, straight from `process_fields.json`. */
export type ProcessFieldType = 'number' | 'boolean' | 'select';

export interface ProcessFieldOption {
  value: string;
  label: string;
}

/** One curated field. Mirrors an entry of `backend/app/data/process_fields.json`. */
export interface ProcessField {
  key: string;
  label: string;
  type: ProcessFieldType;
  category: string;
  description?: string;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  options?: ProcessFieldOption[];
  /** Present only when the field is *not* valid on every supported slicer. */
  slicers?: string[];
}

/** `GET /slicer/process-fields`. */
export interface ProcessFieldsResponse {
  slicer: string;
  fields: ProcessField[];
}

/** `GET /slicer/resolved-process` — raw profile JSON, values string / string[]. */
export type ResolvedProcess = Record<string, unknown>;

/** A value a control can hold, and the spelling the diff is emitted in. */
export type ProcessFieldValue = number | boolean | string;

/**
 * The override diff. Sent verbatim as `SliceRequest.process_overrides`.
 * Contains only keys whose value differs from the resolved default.
 */
export type ProcessOverrides = Record<string, ProcessFieldValue>;

/**
 * Category display order. Chips are still driven by the *data's* own
 * categories — anything not listed here simply sorts last, so a category
 * added to `process_fields.json` later shows up without a frontend change.
 */
export const CATEGORY_ORDER = [
  'quality',
  'strength',
  'speed',
  'support',
  'infill',
  'adhesion',
  'acceleration',
  'multimaterial',
  'advanced',
  'special',
] as const;

/**
 * The Basic tier: the settings someone actually reaches for before a print.
 *
 * `process_fields.json` carries no tier flag — its `advanced` *category* is
 * something else entirely (5 g-code-level fields). So the tier is a curated
 * shortlist here rather than a data property. Advanced shows everything,
 * Basic shows these, and a key that disappears from the curated file just
 * drops out of the list.
 */
export const BASIC_FIELD_KEYS: readonly string[] = [
  'layer_height',
  'initial_layer_print_height',
  'wall_loops',
  'top_shell_layers',
  'bottom_shell_layers',
  'sparse_infill_density',
  'sparse_infill_pattern',
  'enable_support',
  'support_type',
  'support_threshold_angle',
  'brim_type',
  'brim_width',
  'seam_position',
  'ironing_type',
  'outer_wall_speed',
  'inner_wall_speed',
  'sparse_infill_speed',
];

/**
 * Roughly how many settings the slicers expose in total.
 *
 * Shown next to the field count so the editor says out loud that it covers a
 * curated subset. Deliberately a floor ("545+"), not a precise number — the
 * two slicers do not agree on one and the curated file is the only thing
 * here that is exact.
 */
export const APPROX_TOTAL_SLICER_SETTINGS = 545;

/** Truthy spellings a profile uses for a boolean. */
const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_TOKENS = new Set(['0', 'false', 'no', 'off', '']);

/**
 * The resolved profile's value for `field`, typed for a control.
 *
 * Returns `null` when the preset does not carry the key or spells it in a way
 * the field's type cannot hold. `null` means "this preset does not say" — it
 * is not the same as a value, and any user entry against it is an override.
 */
export function parseResolvedValue(
  field: ProcessField,
  resolved: ResolvedProcess | null | undefined,
): ProcessFieldValue | null {
  if (!resolved) return null;
  let raw: unknown = resolved[field.key];
  // Per-extruder settings arrive as a list; the editor edits the first entry,
  // which is what the single-extruder machines this targets actually use.
  if (Array.isArray(raw)) raw = raw.length > 0 ? raw[0] : undefined;
  if (raw === undefined || raw === null) return null;

  if (field.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const token = String(raw).trim().toLowerCase();
    if (TRUE_TOKENS.has(token)) return true;
    if (FALSE_TOKENS.has(token)) return false;
    return null;
  }

  if (field.type === 'select') {
    const token = String(raw);
    const options = field.options ?? [];
    // A value the curated options do not list would fail the backend's own
    // check, so it is treated as "no default" rather than silently offered.
    return options.some((option) => option.value === token) ? token : null;
  }

  // number — strip the '%' a percent-unit profile value carries.
  const text = String(raw).trim().replace(/%$/, '');
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Resolved default per field key. `null` where the preset says nothing. */
export function resolveDefaults(
  fields: ProcessField[],
  resolved: ResolvedProcess | null | undefined,
): Record<string, ProcessFieldValue | null> {
  const defaults: Record<string, ProcessFieldValue | null> = {};
  for (const field of fields) defaults[field.key] = parseResolvedValue(field, resolved);
  return defaults;
}

/**
 * Equality as the diff means it.
 *
 * Numbers compare with a tolerance because the default is parsed out of a
 * decimal string and the entry comes back through an `<input>` — `0.20` and
 * `0.2` are the same setting and must not read as a change.
 */
export function valuesEqual(
  a: ProcessFieldValue | null | undefined,
  b: ProcessFieldValue | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/** `value` pulled into the field's curated `min`/`max`. */
export function clampToRange(field: ProcessField, value: number): number {
  let clamped = value;
  if (typeof field.min === 'number' && clamped < field.min) clamped = field.min;
  if (typeof field.max === 'number' && clamped > field.max) clamped = field.max;
  return clamped;
}

/**
 * The diff after setting `key` to `value` — the one rule, in one place.
 *
 * `undefined` reverts the key. So does a `value` equal to its resolved
 * default: the entry is *removed*, never written as a no-op. Keys the caller
 * put in `overrides` that are not in `defaults` are passed through untouched
 * — this component only speaks for the fields it was handed.
 */
export function nextOverrides(
  overrides: ProcessOverrides,
  defaults: Record<string, ProcessFieldValue | null>,
  key: string,
  value: ProcessFieldValue | undefined,
): ProcessOverrides {
  const next = { ...overrides };
  if (value === undefined || valuesEqual(value, defaults[key])) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Drop every no-op entry for a known field.
 *
 * The editor never emits one, but a caller can hand one in — #15 prefills
 * from a previous slice, and the resolved defaults move when the process
 * preset changes under it. Running the incoming object through this keeps
 * "what is marked as changed" and "what gets sent" the same set.
 */
export function sanitizeOverrides(
  overrides: ProcessOverrides,
  defaults: Record<string, ProcessFieldValue | null>,
): ProcessOverrides {
  const clean: ProcessOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key in defaults && valuesEqual(value, defaults[key])) continue;
    clean[key] = value;
  }
  return clean;
}

/** Keys of `fields` that are genuinely overridden. */
export function overriddenKeys(
  fields: ProcessField[],
  overrides: ProcessOverrides,
  defaults: Record<string, ProcessFieldValue | null>,
): string[] {
  return fields
    .filter((field) => field.key in overrides && !valuesEqual(overrides[field.key], defaults[field.key]))
    .map((field) => field.key);
}

/** Search over label, key and description. Empty query matches everything. */
export function matchesQuery(field: ProcessField, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    field.label.toLowerCase().includes(needle) ||
    field.key.toLowerCase().includes(needle) ||
    (field.description ?? '').toLowerCase().includes(needle)
  );
}

/**
 * Filter the field list for the current tier / category / search.
 *
 * Search deliberately ignores the tier: someone who types "acceleration"
 * wants the field, not a lesson about which tier it lives in. The category
 * chip still applies, because that is an explicit narrowing the user made.
 */
export function filterFields(
  fields: ProcessField[],
  options: { tier: 'basic' | 'advanced'; category: string | null; query: string },
): ProcessField[] {
  const searching = options.query.trim() !== '';
  const basic = new Set(BASIC_FIELD_KEYS);
  return fields.filter((field) => {
    if (!searching && options.tier === 'basic' && !basic.has(field.key)) return false;
    if (options.category !== null && field.category !== options.category) return false;
    return matchesQuery(field, options.query);
  });
}

/** Categories present in `fields`, in `CATEGORY_ORDER` then alphabetical. */
export function categoriesOf(fields: ProcessField[]): string[] {
  const present = [...new Set(fields.map((field) => field.category))];
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number]);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * A number as an input should show it — no exponent, no float noise.
 * `0.1 + 0.2` never reaches here, but a clamped `max` might carry a tail.
 */
export function formatNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}
