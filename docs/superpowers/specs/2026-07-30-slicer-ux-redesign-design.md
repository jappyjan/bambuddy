# Slicing & file-management UX redesign

**Date:** 2026-07-30
**Status:** Approved design, not yet implemented
**Fork policy:** All work stays on this fork. No PRs to the upstream repository until the owner has manually tested the full flow.

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
| Settings UI source | `process_fields.json`, rendered generically. | The metadata already exists with labels, units and ranges. Rendering it is a view problem, not a data problem. |
| Per-slice overrides | `process_overrides: dict` on `SliceRequest`, patched server-side into the resolved process JSON. | Reuses the mechanism `bed_type` already proves. No preset cloning, no new preset rows. |
| Placement persistence | `plate_layout` JSON column on the source file. Reset-to-original available. | Re-opening the slicer restores the arrangement. Source 3MF bytes are never mutated, so nothing is destructive and no versioning is required. |
| Grouping mechanism | `sliced_from_file_id` FK on `library_files`. | One nullable column closes the gap. The source id is already in scope where the output row is created. |
| Backfill of existing sliced files | None. | No recoverable link exists. Filename matching would mis-group as often as it helped. Grouping applies to new slices only. |

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
| `GET /slicer/process-fields` — serve `process_fields.json` under the slicer namespace | `backend/app/api/routes/slicer_presets.py` |
| `GET /slicer/resolved-process?source=<local\|cloud\|orca_cloud\|standard>&id=<id>` — the resolved process JSON, so the editor shows real current values instead of field defaults. `PresetRef` is split into two query params rather than encoded as one, matching how the existing preset endpoints take it. | new |

### Override validation

`process_overrides` keys are validated against `process_fields.json` before patching:

- Unknown key → HTTP 422. Not silently dropped, not passed through to the slicer.
- Numeric value outside the field's `min`/`max` → HTTP 422.
- `select` value not among the field's options → HTTP 422.
- Type mismatch → HTTP 422.

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

Eight PRs, each independently mergeable and each shipping something demonstrable. Dependencies are strictly backward — no step requires a later one.

Steps 1→2→3 and 4→7 are independent chains and can be started in parallel worktrees immediately.

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

### Step 4 — Per-slice setting overrides (backend)

> As a user, I can override individual print settings for one slice without cloning a preset.

- `process_overrides` on `SliceRequest`.
- Generalise the `bed_type` patcher to N keys.
- Validation per §5.
- `GET /slicer/process-fields` and `GET /slicer/resolved-process`.

**Acceptance:** a slice request carrying `{"sparse_infill_density": 25}` produces G-code sliced at 25% infill. An unknown key and an out-of-range value each return 422. `bed_type` still works unchanged.

**Depends on:** nothing.

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

**Read the STL risk in §9 before starting.** Verify the STL path against a real sidecar early — the outcome may change the approach.

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
- Transform rewriting round-tripped through `ThreeMFParser`: geometry counts unchanged, transforms updated.

**Frontend** (`vitest`):

- `useSlicePresets` parity with `SliceModal`'s current defaulting and compatibility behaviour. **Write this first in step 5** — it is the regression guard for the riskiest extraction in the project.
- Nested grouping renders parents with children collapsed and expands on demand.
- Inspector panel opens, reflows the grid, and switches files without unmounting.
- `ProcessSettingsEditor` emits only changed fields, and emits nothing when a value is set back to the resolved default.
- Wizard step gating, and Review-first mount for a previously-sliced file.

## 9. Risks

**STL placement (affects step 7).** 3MF placement is clean: rewrite the build-item matrices, which is the container's purpose. STL has nowhere to hold a transform, so the matrix must be baked into the vertices — and BambuStudio may then re-centre the model on the bed and discard the translation. Verify against a real sidecar before building the rest of the step. If auto-centring wins, the fallback is wrapping the STL in a minimal 3MF on first placement, which also removes the STL special case entirely. This is called out rather than pre-decided because the answer is empirical.

**`process_fields.json` coverage (affects steps 4, 5).** 102 fields is a strong subset, not the roughly 400 BambuStudio exposes. Users who search for an absent setting will notice. The editor must state its scope plainly — "102 of the most-used settings" — rather than implying completeness. Growing the file is a separate, additive piece of work.

**`FileManagerPage.tsx` size (affects steps 2, 3).** Already at 2,776 lines. Two UI steps land in it. Extract only what each step touches; resist a general refactor, and resist leaving new code inline.

## 10. Out of scope

- Removing `SliceModal` (later cleanup, after hardware testing).
- Backfilling provenance for existing sliced files.
- Expanding `process_fields.json` beyond its current 102 fields.
- Filament and printer preset field editors — process only.
- Archive-to-archive slice provenance and grouping in the archive list (see §4).
- Multi-object plate composition (adding a second model to a plate). Placement operates on objects the source file already contains.
- Any PR to the upstream repository.

## 11. Reference

Approved mockups: `frontend/mockups/slicer-ux-redesign.html` — desktop file browser with inspector panel, desktop slicer, and the three phone strategies considered (the guided-steps variant is the chosen one).
