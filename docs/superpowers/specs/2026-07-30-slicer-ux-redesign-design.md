# Slicing & file-management UX redesign

**Date:** 2026-07-30
**Status:** Approved design, not yet implemented
**Fork policy:** All work happens in forks under `jappyjan` — `jappyjan/bambuddy` and `jappyjan/orca-slicer-api`. **Nothing is pushed or proposed to any `maziggy/*` repository or registry** until the owner has tested the full flow from the forks. Upstream PRs are a single deliberate step at the end, not something individual tickets do.

**Sidecar images:** use `ghcr.io/jappyjan/orca-slicer-api` and `ghcr.io/jappyjan/bambu-studio-api` — these carry the `GET /schema` endpoint of §7 Step 4b. The `ghcr.io/maziggy/*` images are unchanged and **do not** have it. Both fork packages are private; pulling needs `docker login ghcr.io` with a `read:packages` token.

---

## 1. Goal

Make slicing in Bambuddy feel like using a desktop slicer next to an operating-system file browser, the way SimplyPrint's panel does:

1. Browse files, click one, see its details and actions without leaving the folder.
2. Slice from a real slicer surface — 3D view, plate placement, the full settings set — not a stack of dropdowns in a modal.
3. Start the print from the slicer, without a round trip back to the file manager.
4. Sliced output files are grouped under the source file they came from instead of sitting beside it as an unrelated row.
5. Works on a phone. Desktop is 3D-centred; phone is menu-centred.

## 2. Starting point

| Piece | Today |
|---|---|
| File browser | `frontend/src/pages/FileManagerPage.tsx`, 2,776 lines. Folder-tree sidebar (resizable), grid/list of `FileCard`s with hover action buttons, `lg:` breakpoints already in place, `useIsMobile()` available. Clicking a card selects it for bulk operations — there is no detail view. |
| Slicer | `frontend/src/components/SliceModal.tsx`, 1,142 lines. Modal with printer / process / per-slot filament dropdowns, plate picker, bed-type override, "slice as designed" toggle, slicer-pipeline presets. No 3D, no per-setting control. Closes on success. |
| 3D viewer | `frontend/src/components/ModelViewer.tsx`. three.js with `OrbitControls`. Read-only — no gizmos, no scene mutation. |
| Sliced output | `slice_and_persist_as_library_file()`, `backend/app/api/routes/library.py:4002`. Creates a `LibraryFile` with `source_type="sliced"` and **no link to the source file**. |
| Setting metadata | `backend/app/data/process_fields.json` — 102 process parameters with label, type, unit, min/max, step and one of 10 categories (quality, strength, speed, support, infill, adhesion, acceleration, multimaterial, advanced, special). Served at `GET /cloud/preset-fields/{type}`. **No frontend consumer.** |
| Per-slice config patching | `backend/app/api/routes/library.py:3355` patches `curr_bed_type` into the resolved process JSON before dispatch. Single-key today; the shape generalises. |
| Sidecar contract | `SlicerApiService.slice_with_profiles(model_bytes, model_filename, …)`, `backend/app/services/slicer_api.py:256`. Takes model bytes, so any geometry or transform change must be applied to the bytes Bambuddy sends. |

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Where file detail lives | Right-hand inspector panel; grid reflows narrower. Bottom sheet on mobile. | The detail view must be cheap to open *and* cheap to abandon, so a folder can be skimmed by clicking. Additive to the existing `lg:flex-row` layout rather than a rewrite. |
| Desktop slicer layout | Left rail (presets + settings editor) beside a dominant 3D stage, action bar along the bottom of the stage. | Matches the reference product and the shape users know from BambuStudio / OrcaSlicer. |
| Phone slicer layout | Guided steps: Printer → Filaments → Settings → Review. | Chosen by the project owner over bottom tabs and a draggable split. Most beginner-proof on a small screen. |
| Repeat-slice on phone | A file with a previous slice opens the wizard **on Review**, last settings pre-filled, earlier steps reachable as editable chips. | Removes the wizard's one real weakness — four screens to change nothing. First slice stays guided; repeat slice is two taps. |
| Slicer surface | A route, `/slicer?file=42` (`?archive=7` for archives). | Deep-linkable, survives refresh, browser Back works, matches the reference product's URL shape. A modal cannot hold a viewport plus a settings tree comfortably. |
| Settings UI source | `process_fields.json` for metadata, intersected with the target slicer's real key set from the sidecar. | Labels, units and ranges exist nowhere else — the CLIs do not emit them (§3a). Which keys are *valid*, however, differs per slicer and must come from the slicer itself. |
| Per-slice overrides | `process_overrides: dict` on `SliceRequest`, patched server-side into the resolved process JSON. | Reuses the mechanism `bed_type` already proves. No preset cloning, no new preset rows. |
| Placement persistence | `plate_layout` JSON column on the source file. Reset-to-original available. | Re-opening the slicer restores the arrangement. Source 3MF bytes are never mutated, so nothing is destructive and no versioning is required. |
| Grouping mechanism | `sliced_from_file_id` FK on `library_files`. | One nullable column closes the gap. The source id is already in scope where the output row is created. |
| Backfill of existing sliced files | None. | No recoverable link exists. Filename matching would mis-group as often as it helped. Grouping applies to new slices only. |

## 3a. Verified sidecar behaviour

Run 2026-07-30 against `ghcr.io/maziggy/orca-slicer-api:latest` (OrcaSlicer 2.3.2) and `ghcr.io/maziggy/bambu-studio-api:latest` (BambuStudio 02.07.01.57), both `linux/amd64` under emulation on an arm64 host. Only the Compose stack lives in this repo.

> The `maziggy` image names above are what the spike was run against, and the measurements below still hold — the two namespaces differ only by the added `/schema` endpoint. **New work should use the `ghcr.io/jappyjan/*` images** (see the fork policy at the top). Sidecar source now lives in the fork, `jappyjan/orca-slicer-api` @ `bambuddy/profile-resolver`.

Facts established, replacing what was previously guesswork:

**1. There is no rich schema dump.** `--help-fff` does not exist in either binary (removed upstream). Neither CLI emits labels, units, ranges or enum options for its settings. **Field metadata must stay hand-curated** — `process_fields.json` is doing the part that cannot be automated.

**2. The authoritative key list *is* obtainable.** `--export-settings out.json` writes every setting the binary knows, with its current value:

| | keys |
|---|---|
| BambuStudio 02.07 | 545 |
| OrcaSlicer 2.3.2 | 572 |
| common to both | 394 |
| BambuStudio-only | 151 |
| OrcaSlicer-only | 178 |

**3. `process_fields.json` is partly invalid, including for the slicer it targets.** The file is labelled "for Bambu Lab printers", but of its 102 keys:

- **91 of 102 valid on BambuStudio** — 11 keys do not exist: `bridge_acceleration`, `fuzzy_skin_point_dist`, `gcode_comments`, `infill_anchor`, `infill_anchor_max`, `initial_layer_height`, `only_one_wall_top`, `overhang_speed_classic`, `prime_tower_enable`, `prime_volume`, `staggered_inner_seams`
- **98 of 102 valid on OrcaSlicer** — 4 do not exist: `fuzzy_skin_point_dist`, `initial_layer_height`, `overhang_speed_classic`, `prime_tower_enable`

Four are wrong on *both*, and mostly look like naming drift — OrcaSlicer spells them `fuzzy_skin_point_distance`, `initial_layer_print_height`, `enable_prime_tower`. `overhang_speed_classic` has no equivalent at all. Note that `initial_layer_height` appears as an overridden field in the approved mockup; it is one of the broken ones.

**Consequence:** validating overrides against `process_fields.json`, as §5 originally specified, would happily accept keys the slicer then silently ignores. The user changes a setting, the slice succeeds, nothing differs, and nothing reports why. Validation must go against the target slicer's real key set.

**4. Settings can be passed directly on the command line.** `--layer-height 0.3` was accepted and the exported settings confirmed `layer_height: 0.3`; the CLI documents command-line values as the highest-priority source, above `--load-settings` and above the 3MF. So overrides have two viable transports. **The design keeps JSON patching anyway** — it is already proven in this codebase for `bed_type`, needs no sidecar change, and does not put user-supplied strings into an argv.

**5. The CLI transform flags are not a placement shortcut.** `--scale`, `--rotate`, `--rotate-x/y` exist on both binaries. On BambuStudio `--scale 2 --export-3mf` succeeded; on OrcaSlicer the same call **segfaulted, on both STL and 3MF input**. This was on an emulated amd64 host, so the segfault needs confirming on real x86_64 before being treated as settled. Regardless: these flags are *global* — one scale, one rotation, applied to the whole model — so they cannot express per-object placement on a multi-object plate. Byte-rewriting remains the approach. The flags are at best a fallback for single-object STL on BambuStudio only, and are not part of this design.

## 4. Data model

Two nullable columns on `library_files` (`backend/app/models/library.py`):

```python
sliced_from_file_id: Mapped[int | None] = mapped_column(
    ForeignKey("library_files.id", ondelete="SET NULL"), nullable=True, index=True
)
plate_layout: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

`ON DELETE SET NULL`, not `CASCADE`: deleting a source model must not destroy a printable G-code the user may still need.

`print_archives` gets **`plate_layout` only** — the slicer page must work when opened from `ArchivesPage`, so an archive needs somewhere to store its arrangement. Archive-to-archive slice provenance is deliberately not modelled: grouping was asked for in the file manager, the archive list is a different surface with its own grouping semantics, and adding a second provenance FK now would be speculative. If it turns out to be wanted, it is an additive column later.

`slice_count` is derived, not stored: a `COUNT` of rows whose `sliced_from_file_id` is this file and whose `deleted_at` is null. Trashed slices do not inflate the badge.

Migrations follow the existing `_safe_execute(conn, "ALTER TABLE …")` pattern in `backend/app/core/database.py`.

### `plate_layout` shape

```json
{
  "version": 1,
  "plates": {
    "1": [
      {"object_id": "2", "position": [128.0, 128.0, 0.0],
       "rotation": [0.0, 0.0, 45.0], "scale": [1.0, 1.0, 1.0]}
    ]
  }
}
```

- `version` is present so a future shape change is detectable. Readers reject anything other than `1`.
- Plate keys are stringified plate numbers, 1-indexed, matching the existing plate addressing used by `plate` on `SliceRequest`.
- `object_id` matches the 3MF object id `ModelViewer` already parses into `ObjectData.id`.
- `position` is millimetres in bed coordinates, `rotation` is degrees XYZ, `scale` is a multiplier per axis.
- Objects absent from the array keep their original transform. An absent or `null` column means "as designed".

## 5. API changes

| Change | Location |
|---|---|
| `sliced_from_file_id` and `slice_count` on library-file list and detail responses | `backend/app/schemas/library.py` |
| `?group=nested` on the file-list endpoint — sliced children nested inside their parent rather than returned as siblings | `backend/app/api/routes/library.py` |
| `GET /library/files/{id}/layout`, `PUT /library/files/{id}/layout` | new |
| `process_overrides: dict[str, Any]` on `SliceRequest` | `backend/app/schemas/slicer.py` |
| `GET /slicer/process-fields` — curated field metadata, filtered to keys the configured slicer actually has | `backend/app/api/routes/slicer_presets.py` |
| `GET /schema` on the **sidecar** — the slicer's real key set and defaults from `--export-settings`, plus slicer name and version | `jappyjan/orca-slicer-api` (fork) |
| `GET /slicer/resolved-process?source=<local\|cloud\|orca_cloud\|standard>&id=<id>` — the resolved process JSON, so the editor shows real current values instead of field defaults. `PresetRef` is split into two query params rather than encoded as one, matching how the existing preset endpoints take it. | new |

### Override validation

Two sources, each authoritative for a different thing (see §3a):

- **The target slicer's key set** — from a new sidecar `GET /schema`, backed by `--export-settings`. Authoritative for *whether a key exists*.
- **`process_fields.json`** — authoritative for *label, unit, type, range and category*. The only source for these; the CLI does not emit them.

The editor renders the intersection: curated fields whose key the active slicer actually has. Fields the active slicer lacks are hidden, not shown-and-broken. `process_overrides` is validated as:

- Key absent from the target slicer's schema → HTTP 422. Not silently dropped, not passed to the slicer.
- Key present in the slicer but absent from `process_fields.json` → HTTP 422. Without metadata there is no range to validate against, so it is not offered.
- Numeric value outside the curated `min`/`max` → HTTP 422.
- `select` value not among the curated options → HTTP 422.
- Type mismatch → HTTP 422.

`/schema` is cached per sidecar URL and slicer version; it changes only when the sidecar image does.

Fixing the 11 bad keys in `process_fields.json` is **step 4a** below — separate from the editor, because it is a data correction that stands on its own and wants its own review.

The patcher is the generalisation of the existing single-key `bed_type` patch at `backend/app/api/routes/library.py:3355`: same position in the pipeline, same resolved-JSON target, N keys instead of one. `bed_type` continues to work as its own field and is not folded into `process_overrides` — existing clients depend on it.

### Layout endpoints

`PUT /library/files/{id}/layout` validates against the shape in §4 and rejects `version != 1`. Writing `null` clears the layout (reset to original).

## 6. Frontend structure

### New units

| Unit | Responsibility | Depends on |
|---|---|---|
| `FileInspectorPanel` | Render one file's metadata, thumbnail/3D preview, and action stack (Slice & Print, Add to queue, Download, Rename, Delete). Emits actions; owns no file state. | file list item, permissions |
| `SlicerPage` | Route container. Owns preset selection, override state, layout state, slice-job state. Chooses desktop split vs mobile wizard via `useIsMobile()`. | `useSlicePresets`, `ProcessSettingsEditor`, `PlateStage` |
| `ProcessSettingsEditor` | Render `process_fields.json` as searchable, category-chipped, Basic/Advanced-tiered fields over a resolved process JSON. Emits an override diff. Renders nothing slicer-specific — reusable in the desktop rail and the wizard's Settings step. | `/slicer/process-fields`, `/slicer/resolved-process` |
| `PlateStage` | 3D viewport: bed, models, plate tabs, gizmo toolbar, transform readout. Emits transform changes. | `ModelViewer`, three.js `TransformControls` |
| `useSlicePresets` | Printer/process/filament defaulting, printer-compatibility filtering, embedded-settings gating, pipeline application. Extracted verbatim from `SliceModal`. | existing preset APIs and `utils/slicePresetPicker` |

`TransformControls` ships in the `three/examples/jsm/controls/` path the project already imports `OrbitControls` from — no new dependency.

### Desktop slicer layout

- **Left rail:** printer / process selects, filament slots grid, build-plate select, then `ProcessSettingsEditor`. Footer shows override count with Reset and Save-as-preset.
- **Stage:** plate tabs top-left, gizmo toolbar (move, rotate, scale, lay flat, auto-arrange) down the left edge, view tools top-right, transform readout bottom-right.
- **Action bar** along the bottom of the stage: time and filament estimate, then Save layout, Slice, and Print now.

**Print now** is enabled only while the last completed slice still matches the current selections. Changing any preset, override, plate or transform invalidates it and disables the button until the user slices again — so the button can never dispatch a print that does not match what is on screen.

Overridden fields are marked (amber dot in the mockup) and are the only values sent as `process_overrides`.

### Mobile slicer wizard

Steps: **Printer** → **Filaments** → **Settings** → **Review**. A model thumbnail persists across steps; the full viewport is one tap away from any step. Review shows the estimate and both Slice and Print now.

When the file has at least one existing sliced child, the wizard mounts on **Review** with the previous slice's settings pre-filled, and steps 1–3 are reachable as editable chips.

### Existing files

`FileManagerPage.tsx` is 2,776 lines and must not grow. `FileCard`, the folder-tree components, and the inline modals move to their own files **as the steps that touch them arrive** — not as a separate refactor PR, and no further than each step needs.

`SliceModal.tsx` is not deleted in this design. Its pre-pick logic (`SliceModal.tsx:411-465`) is the most load-bearing code in the feature; it is extracted to `useSlicePresets` and consumed by both the old modal and the new page. The modal stays reachable until the new page has had real-hardware testing. Removing it is a later cleanup, out of scope here.

## 7. Implementation steps

Ten PRs, each independently mergeable and each shipping something demonstrable. Dependencies are strictly backward — no step requires a later one.

Three chains start with no dependencies and can go into parallel worktrees immediately:

- **1 → 2 → 3** — provenance, grouping, inspector panel
- **4a → 4 → 7** — field-data correction, overrides, placement backend
- **4b** — the sidecar `/schema` endpoint, alone and in a different repository

Steps 5, 6 and 8 join the chains back together and cannot start until their dependencies land.

---

### Step 1 — Sliced-file provenance

> As a user, my sliced files remember which file they came from.

- Add `sliced_from_file_id` and `plate_layout` to `library_files`, and `plate_layout` to `print_archives`, with migrations.
- Set `sliced_from_file_id` in `slice_and_persist_as_library_file()`.
- Expose `sliced_from_file_id` and the derived `slice_count` on library-file schemas.

**Acceptance:** slicing a library file returns an output row whose `sliced_from_file_id` is the source id. Deleting the source leaves the sliced row present with `sliced_from_file_id` null. Trashing a slice decrements the source's `slice_count`.

**Depends on:** nothing.

---

### Step 2 — Grouped display

> As a user, sliced outputs appear nested under their source instead of cluttering the folder.

- `?group=nested` on the file-list endpoint.
- Parent `FileCard` gains an expand chevron and a slice-count badge; children render indented.
- Ungrouped sliced files (no parent, e.g. pre-existing rows) continue to render as normal top-level cards.

**Acceptance:** a folder containing a source and its slice shows one card that expands to reveal the slice. Sort and filter operate on parents; expanding does not reorder.

**Depends on:** step 1.

---

### Step 3 — File inspector panel

> As a user, clicking a file shows me its details and what I can do with it, without navigating away.

- `FileInspectorPanel` as a sibling of the grid inside the existing `lg:flex-row` container (`FileManagerPage.tsx:1961`).
- Grid reflows to fewer columns while the panel is open. Clicking another file updates the panel in place.
- Mobile: same component in a bottom sheet, draggable to full height.
- Slice button still opens the existing `SliceModal`.

**Acceptance:** clicking through several files updates the panel without navigation. The panel closes and the grid returns to full width. On a phone viewport the sheet appears and can be dismissed.

**Depends on:** step 2.

---

### Step 4a — Correct `process_fields.json`

> As a user, every setting the slicer UI offers me actually does something.

- Fix the 11 keys listed in §3a: rename where an equivalent exists (`fuzzy_skin_point_distance`, `initial_layer_print_height`, `enable_prime_tower`, …), drop where none does (`overhang_speed_classic`).
- Where a key exists on one slicer but not the other, tag the field with the slicers it applies to rather than deleting it.
- Add a test that every key in the file is present in at least one of the two committed slicer key-set fixtures.

**Acceptance:** every remaining key resolves on at least one slicer, and the test fails if a future edit introduces one that resolves on neither.

**Depends on:** nothing. Sequence before step 5 so the editor never ships offering dead settings.

**Note:** this repo has no committed key-set fixture yet. Generate the two fixtures by running `--export-settings` in each sidecar image, as §3a describes, and commit them as test data.

---

### Step 4b — Sidecar `/schema` endpoint

> As Bambuddy, I can ask the sidecar what settings its slicer actually supports.

- In the fork `jappyjan/orca-slicer-api` @ `bambuddy/profile-resolver` (**never** upstream `maziggy`): `GET /schema` runs `--export-settings` against a throwaway model once at startup, caches it, and returns `{slicer, version, keys, defaults}`.
- Both images build from the same Node source, so one implementation covers both.
- Bambuddy caches the response per sidecar URL and version.

**Acceptance:** `GET /schema` on each image returns the key counts in §3a (545 for BambuStudio, 572 for OrcaSlicer) and the correct version string. An unreachable or old sidecar makes Bambuddy fall back to the curated file's own key list, degraded but working.

**Depends on:** nothing. **This is the only step in a different repository** — flag it for whoever picks it up, and note the image must be rebuilt and pushed before step 5 can consume it.

---

### Step 4 — Per-slice setting overrides (backend)

> As a user, I can override individual print settings for one slice without cloning a preset.

- `process_overrides` on `SliceRequest`.
- Generalise the `bed_type` patcher to N keys.
- Two-source validation per §5, with the graceful fallback when `/schema` is unavailable.
- `GET /slicer/process-fields` (filtered to the active slicer) and `GET /slicer/resolved-process`.

**Acceptance:** a slice request carrying `{"sparse_infill_density": 25}` produces G-code sliced at 25% infill. A key the target slicer does not have, a key with no curated metadata, and an out-of-range value each return 422. `bed_type` still works unchanged. With the sidecar's `/schema` unreachable, overrides still work against the curated key list.

**Depends on:** step 4a. Consumes step 4b when available, degrades without it.

---

### Step 5 — Desktop slicer page

> As a desktop user, I get a real slicer page with a 3D view and full settings, and can start the print from it.

- Route `/slicer?file=42` and `?archive=7`.
- Extract `useSlicePresets` from `SliceModal`; the modal consumes the hook and keeps working identically.
- `SlicerRail` (presets + `ProcessSettingsEditor`), `PlateStage` in **read-only** mode (orbit only — gizmos arrive in step 8), action bar.
- Slice runs through the existing slice-job dispatch and progress tracking. Print now hands the produced file to the existing `PrintModal`.
- Inspector's Slice button now routes here.

**Acceptance:** slicing from the page produces the same output as the modal for the same selections. Overriding a setting in the rail changes the result. Print now dispatches to a printer without returning to the file manager.

**Depends on:** steps 3, 4.

---

### Step 6 — Mobile slicer wizard

> As a phone user, slicing walks me through it one decision at a time.

- Wizard steps, progress dots, per-step validation gating Next.
- Review-first mount for files with an existing sliced child.
- Same `SlicerPage` state; only presentation differs.

**Acceptance:** on a phone viewport, a never-sliced file opens at step 1 and reaches a successful slice. A previously-sliced file opens on Review with prior settings, and Slice works without visiting earlier steps.

**Depends on:** step 5.

---

### Step 7 — Apply placement at slice time (backend)

> As a user, my arrangement of the plate is applied when I slice.

- Layout GET/PUT endpoints with validation.
- Apply the stored layout to the model bytes before they reach `slice_with_profiles`.
  - **3MF:** rewrite the build-item transform matrices. This is what the container is for.
  - **STL:** bake the matrix into the vertices.
- No UI in this step.

**Acceptance:** a file with a stored non-identity layout slices to G-code whose first-layer extents differ from the same file sliced with no layout, in the expected direction. `ThreeMFParser` still parses the rewritten 3MF and reports unchanged geometry counts.

**Depends on:** step 4.

**Read §3a item 5 and the STL risk in §9 before starting.** The CLI transform flags are not a shortcut — they are global, and they segfault on OrcaSlicer. Byte-rewriting is the approach.

---

### Step 8 — Interactive placement (frontend)

> As a user, I can move, rotate, scale and auto-arrange models on the plate, and my arrangement is remembered.

- `TransformControls` in `PlateStage`, gizmo toolbar, live transform readout, numeric entry.
- Lay flat and auto-arrange.
- Save layout persists via `PUT .../layout`; Reset to original clears it.
- Touch-sized gizmo targets so the mobile viewport is usable.

**Acceptance:** dragging a model updates the readout, Save layout persists it, reloading the page restores the arrangement, and slicing reflects it. Reset returns the model to its original transform.

**Depends on:** steps 5, 7.

---

## 8. Testing

**Backend** (`pytest`, existing layout under `backend/tests/`):

- `sliced_from_file_id` set on slice; `SET NULL` on source delete — extends `backend/tests/integration/test_library_slice_api.py`.
- Nested-grouping response shape, including a source with several slices and a sliced file with no parent.
- Override validation: unknown key, out-of-range numeric, bad `select` value, type mismatch.
- The generalised patcher against a real process-JSON fixture, asserting `bed_type` behaviour is unchanged.
- `plate_layout` schema validation, including `version` rejection.
- Every key in `process_fields.json` resolves against at least one committed slicer key-set fixture (step 4a), so a future edit cannot reintroduce a dead setting unnoticed.
- Override validation with `/schema` mocked as unreachable, proving the degraded path still slices.
- Byte-rewritten 3MFs exercised against **both** sidecars, not only the configured default — see the OrcaSlicer risk in §9.
- Transform rewriting round-tripped through `ThreeMFParser`: geometry counts unchanged, transforms updated.

**Frontend** (`vitest`):

- `useSlicePresets` parity with `SliceModal`'s current defaulting and compatibility behaviour. **Write this first in step 5** — it is the regression guard for the riskiest extraction in the project.
- Nested grouping renders parents with children collapsed and expands on demand.
- Inspector panel opens, reflows the grid, and switches files without unmounting.
- `ProcessSettingsEditor` emits only changed fields, and emits nothing when a value is set back to the resolved default.
- Wizard step gating, and Review-first mount for a previously-sliced file.

## 9. Risks

**STL placement (affects step 7).** 3MF placement is clean: rewrite the build-item matrices, which is the container's purpose. STL has nowhere to hold a transform, so the matrix must be baked into the vertices — and the slicer may then re-centre the model on the bed and discard the translation. §3a ruled out the CLI-flag shortcut but did not answer the re-centring question, which still needs a real slice. If auto-centring wins, the fallback is wrapping the STL in a minimal 3MF on first placement, which removes the STL special case entirely. Still empirical, still worth settling first inside step 7.

**OrcaSlicer transform segfault (affects step 7).** `--scale`/`--rotate` segfaulted on OrcaSlicer under emulated amd64. The design does not depend on those flags, so this is not blocking — but it is a signal that OrcaSlicer's model-transform path is less exercised than BambuStudio's, and byte-rewritten 3MFs should be tested against **both** sidecars, not just the default one. Confirm on real x86_64 before drawing conclusions about the binary itself.

**Settings coverage (affects steps 4, 5).** 102 curated fields against 545 (BambuStudio) and 572 (OrcaSlicer) real settings — roughly a fifth. Users who search for an absent setting will notice. The editor must state its scope plainly rather than implying completeness. Growing the file is additive work, and §3a's `--export-settings` dumps give a ready worklist of what is missing; but each added field needs a hand-written label, unit and range, because no machine-readable source for those exists.

**Per-slicer divergence (affects steps 4, 4a, 5).** Only 394 of the two slicers' settings are common; 151 are BambuStudio-only and 178 OrcaSlicer-only. A user switching `preferred_slicer` will see the available field list change, and any saved override referencing a now-absent key must be reported rather than silently dropped. Step 4's 422-on-unknown-key rule is what makes this visible instead of mysterious.

**`FileManagerPage.tsx` size (affects steps 2, 3).** Already at 2,776 lines. Two UI steps land in it. Extract only what each step touches; resist a general refactor, and resist leaving new code inline.

## 10. Out of scope

- Removing `SliceModal` (later cleanup, after hardware testing).
- Backfilling provenance for existing sliced files.
- Expanding `process_fields.json` beyond its current 102 fields. Step 4a corrects the existing ones; it does not add new ones.
- Using the CLI's global `--scale`/`--rotate` flags for placement (see §3a item 5).
- Filament and printer preset field editors — process only.
- Archive-to-archive slice provenance and grouping in the archive list (see §4).
- Multi-object plate composition (adding a second model to a plate). Placement operates on objects the source file already contains.
- Any PR to the upstream repository.

## 11. Reference

Approved mockups: `frontend/mockups/slicer-ux-redesign.html` — desktop file browser with inspector panel, desktop slicer, and the three phone strategies considered (the guided-steps variant is the chosen one).
