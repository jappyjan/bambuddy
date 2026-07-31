# Kickoff prompts — slicer UX redesign

> **Taskbot is the source of truth, not this file.** These steps now live as tickets in the `bambuddy`
> Taskbot project: epic **#1** with eleven children, dependencies wired via `blocked_by`. Dispatch with
> "work on ticket #N" — each ticket body is the full brief.
>
> This file is kept as the offline copy. It differs in one way: Taskbot splits the `useSlicePresets`
> extraction out of step 5 into its own ticket (**#5, step-5a**), because it depends on nothing and can
> start immediately. If the two disagree, Taskbot wins.

Each prompt is self-contained: paste it into a fresh session, no prior context needed.

## Ground rules for every agent

- **Base branch:** `slicer-ux-redesign` on `origin` (`git@github.com:jappyjan/bambuddy.git`). This is the fork. **Never push to, or open a PR against, `maziggy/bambuddy`.**
- **Integration target:** every step PRs *into* `slicer-ux-redesign`, never into `main`. `main` stays clean until the owner has manually tested the whole flow.
- **Worktree per step:** `git worktree add ../bambuddy-step-N slicer-ux-redesign/step-N-<slug>` branching from `origin/slicer-ux-redesign`.
- **Spec:** `docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md`. Read the whole thing once, then your step's section.
- **Mockups:** `frontend/mockups/slicer-ux-redesign.html` — open it in a browser. The approved layouts are option **A** on screen 1 and, on screen 2, the desktop layout as drawn plus phone option **C**.
- **Tests:** `./test_backend.sh` and `./test_frontend.sh` from the repo root. Both must pass before you open a PR. Never report "done" without pasting the output.
- **i18n:** no hardcoded user-visible strings. Keys go in `frontend/src/i18n/locales/` — **all ten locale files**, or `npm run check:i18n` fails the frontend suite. See CONTRIBUTING.md § Internationalization.
- **Stay in your lane:** touch only what your step needs. If you find a problem belonging to another step, write it in your PR description; do not fix it.

## Parallelism

| Can start now | Blocked |
|---|---|
| Step 1, Step 4a, Step 4b | Step 2 (needs 1), Step 3 (needs 2), Step 4 (needs 4a), Step 5 (needs 3+4), Step 6 (needs 5), Step 7 (needs 4), Step 8 (needs 5+7) |

---

## Step 1 — Sliced-file provenance

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.

Create a worktree from origin/slicer-ux-redesign:
  git worktree add ../bambuddy-step-1 -b slicer-ux-redesign/step-1-provenance origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md — all of it, then §4 (Data model)
and §7 Step 1 closely.

Your task: sliced output files must record which file they were sliced from, and source files must
be able to store a plate layout.

- Add `sliced_from_file_id` (FK library_files.id, ON DELETE SET NULL, indexed) and `plate_layout`
  (JSON, nullable) to `library_files` in backend/app/models/library.py.
- Add `plate_layout` only to `print_archives`. Do NOT add a provenance FK to archives — §4 explains why.
- Migrations follow the existing `_safe_execute(conn, "ALTER TABLE …")` pattern in
  backend/app/core/database.py.
- Set `sliced_from_file_id` in `slice_and_persist_as_library_file()` (backend/app/api/routes/library.py,
  around line 4002 — the row is already built there with source_type="sliced"; the source id is in scope).
- Expose `sliced_from_file_id` and a derived `slice_count` on the library-file schemas. slice_count is a
  COUNT of non-trashed children (deleted_at IS NULL), not a stored column.

Acceptance criteria, each of which needs a test:
- Slicing a library file produces an output row whose sliced_from_file_id is the source id.
- Deleting the source leaves the sliced row present with sliced_from_file_id NULL.
- Trashing a slice decrements the source's slice_count.

Extend backend/tests/integration/test_library_slice_api.py rather than starting a new file.

No frontend changes in this step. Run ./test_backend.sh and ./test_frontend.sh, paste the output, then
open a PR into slicer-ux-redesign.
```

---

## Step 2 — Grouped display

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Step 1 (sliced-file provenance) must already be merged into slicer-ux-redesign — verify that
`sliced_from_file_id` exists on the LibraryFile model before you start.

  git worktree add ../bambuddy-step-2 -b slicer-ux-redesign/step-2-grouping origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md, then §7 Step 2.
Open frontend/mockups/slicer-ux-redesign.html — screen 1, option A shows the grouping treatment: a
parent card with an expand chevron and a SLICED badge on the indented child.

Your task: sliced outputs appear nested under the file they came from, instead of as unrelated
siblings cluttering the folder.

- Add `?group=nested` to the library file-list endpoint. Sliced children come back inside their parent.
- The parent FileCard gets an expand chevron and a slice-count badge; children render indented.
- Sliced files with no parent (every pre-existing row — there is deliberately no backfill) keep
  rendering as normal top-level cards. This is not an error case.
- Sorting and filtering operate on parents. Expanding a card must not reorder the grid.

frontend/src/pages/FileManagerPage.tsx is 2,776 lines and must not grow. Extract FileCard to its own
file as part of this step. Do not refactor anything you aren't touching.

Tests: response shape for a source with several slices, and for a sliced file with no parent; the
frontend renders parents collapsed and expands on demand.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 3 — File inspector panel

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Step 2 (grouped display) must already be merged into slicer-ux-redesign.

  git worktree add ../bambuddy-step-3 -b slicer-ux-redesign/step-3-inspector origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md, then §6 (Frontend structure) and
§7 Step 3. Open frontend/mockups/slicer-ux-redesign.html — screen 1, option A. That is the approved
design; build that, at both the desktop and phone sizes shown.

Your task: clicking a file shows its details and available actions without navigating away.

- New component `FileInspectorPanel`: metadata, thumbnail or 3D preview, and an action stack
  (Slice & Print, Add to queue, Download, Rename, Delete). It emits actions and owns no file state.
- Desktop: it mounts as a sibling of the grid inside the existing `lg:flex-row` container at
  frontend/src/pages/FileManagerPage.tsx:1961. The grid reflows to fewer columns while it is open.
- Clicking another file updates the panel in place — no unmount, no navigation. This is the whole point
  of the design; a panel that remounts per file will feel wrong.
- Mobile: the same component in a bottom sheet, draggable to full height. Use the existing
  useIsMobile() hook.
- The Slice button opens the existing SliceModal for now. The slicer page arrives in step 5.
- Respect the existing permission and canModify gating that FileCard already applies to these actions.

Tests: the panel opens, reflows the grid, switches between files without unmounting, and closes.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 4a — Correct `process_fields.json`

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
No dependencies — you can start immediately.

  git worktree add ../bambuddy-step-4a -b slicer-ux-redesign/step-4a-field-data origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md §3a in full. It records a spike
against both slicer binaries and is the reason this step exists.

The problem: backend/app/data/process_fields.json declares 102 process settings and is labelled "for
Bambu Lab printers", but only 91 of its keys exist in BambuStudio 02.07 and 98 in OrcaSlicer 2.3.2.
The rest silently do nothing. These 11 are absent from BambuStudio:

  bridge_acceleration, fuzzy_skin_point_dist, gcode_comments, infill_anchor, infill_anchor_max,
  initial_layer_height, only_one_wall_top, overhang_speed_classic, prime_tower_enable, prime_volume,
  staggered_inner_seams

Four of those are absent from BOTH slicers. Known correct spellings on OrcaSlicer:
  fuzzy_skin_point_dist  -> fuzzy_skin_point_distance
  initial_layer_height   -> initial_layer_print_height
  prime_tower_enable     -> enable_prime_tower
  overhang_speed_classic -> no equivalent; drop it

Your task:
1. Generate the ground truth. For each sidecar image, run the slicer CLI's --export-settings against a
   throwaway model and commit the resulting key list as a test fixture. §3a documents the exact
   invocation, the binary paths inside each image, and the expected key counts (545 BambuStudio,
   572 OrcaSlicer). BambuStudio needs LD_LIBRARY_PATH pointing at its own bin directory or it will not
   start. Commit key lists only — not the full value dumps.
2. Fix the keys. Rename where an equivalent exists; drop where none does.
3. Where a key is valid on one slicer but not the other, tag the field with which slicers it applies to
   rather than deleting it. Both slicers are supported; 151 settings are BambuStudio-only and 178 are
   OrcaSlicer-only, so this tagging is load-bearing for step 4, not cosmetic.
4. Add a test asserting every key in process_fields.json resolves against at least one fixture, so a
   future edit cannot reintroduce a dead setting unnoticed.

Do not add new fields. Correcting the existing ones is the whole scope.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 4b — Sidecar `/schema` endpoint

```
This is the only step in a different repository.

The Bambuddy slicer sidecar lives at github.com/maziggy/orca-slicer-api, branch
bambuddy/profile-resolver. Both published images (ghcr.io/maziggy/orca-slicer-api and
ghcr.io/maziggy/bambu-studio-api) are the same Node service bundled with a different slicer binary, so
one implementation covers both. Clone it; it is not checked out locally.

Context lives in the Bambuddy repo at docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md
§3a and §7 Step 4b — read those first (branch slicer-ux-redesign on
git@github.com:jappyjan/bambuddy.git). You do not need to modify Bambuddy itself.

Your task: add `GET /schema` so Bambuddy can ask the sidecar what settings its slicer actually supports.

- Run the bundled slicer CLI's `--export-settings` against a throwaway model once at startup, cache the
  result, and serve `{slicer, version, keys, defaults}`.
- `keys` is the authoritative list of setting names the binary knows. Bambuddy needs it because the two
  slicers differ: 545 keys on BambuStudio, 572 on OrcaSlicer, only 394 in common. Bambuddy currently
  validates user overrides against a hand-maintained file and would accept settings the slicer silently
  ignores.
- Report the real binary version, not the image tag. The CLIs print it on --help
  ("OrcaSlicer-2.3.2", "BambuStudio-02.07.01.57").
- Note for the BambuStudio image: the binary needs LD_LIBRARY_PATH set to its own bin directory
  (/app/squashfs-root/bin) or it fails to load libavcodec.so.61.

Acceptance: GET /schema on each image returns the key counts above and the correct version string.
Follow whatever test conventions that repo already uses.

Then rebuild and push both images — Bambuddy's step 5 cannot consume this until the published images
carry it. Say explicitly in your PR whether you pushed them and with what tag.
```

---

## Step 4 — Per-slice setting overrides

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Step 4a (corrected field data) must already be merged into slicer-ux-redesign. Step 4b (sidecar
/schema) is optional — build the graceful fallback so this works without it.

  git worktree add ../bambuddy-step-4 -b slicer-ux-redesign/step-4-overrides origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md — §3a, §5 (API changes and Override
validation), and §7 Step 4.

Your task: a user can override individual print settings for one slice, without cloning a preset.

- Add `process_overrides: dict[str, Any]` to SliceRequest in backend/app/schemas/slicer.py.
- Generalise the existing single-key bed_type patcher at backend/app/api/routes/library.py:3355 to patch
  N keys into the resolved process JSON. Same position in the pipeline, same target. `bed_type` keeps
  working as its own field — existing clients depend on it; do not fold it into process_overrides.
- Validation has two sources, each authoritative for a different thing, and §5 spells out the rules:
  the target slicer's key set (from the sidecar's /schema) decides whether a key EXISTS; the curated
  process_fields.json decides its label, type and range. Reject with 422 rather than dropping silently —
  a setting that quietly does nothing is the exact failure this step exists to prevent.
- When /schema is unreachable (old sidecar, sidecar down), fall back to the curated file's own key list.
  Degraded, still working. Cache /schema per sidecar URL and slicer version.
- Add `GET /slicer/process-fields` (curated metadata, filtered to keys the configured slicer has) and
  `GET /slicer/resolved-process?source=<...>&id=<...>` (the resolved process JSON, so a UI can show real
  current values instead of field defaults). §5 explains why PresetRef is two query params, not one.

Backend only — no UI in this step. Everything is testable via the API.

Tests: a request carrying {"sparse_infill_density": 25} produces G-code sliced at 25% infill; a key the
target slicer lacks, a key with no curated metadata, and an out-of-range value each return 422;
bed_type still works unchanged; overrides still work with /schema mocked unreachable.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 5 — Desktop slicer page

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Steps 3 (inspector panel) and 4 (overrides) must already be merged into slicer-ux-redesign.

  git worktree add ../bambuddy-step-5 -b slicer-ux-redesign/step-5-slicer-page origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md — §6 (Frontend structure) and
§7 Step 5. Open frontend/mockups/slicer-ux-redesign.html and scroll to "Proposed desktop layout" on
screen 2. That is the approved design. Build that.

Your task: a real slicer page, with a 3D view and the full settings set, that can start the print.

- Route /slicer?file=42 (and ?archive=7).
- FIRST, before any UI: extract the preset pre-pick logic from frontend/src/components/SliceModal.tsx
  (lines ~411-465 — printer/process/filament defaulting, printer-compatibility filtering,
  embedded-settings gating) into a `useSlicePresets` hook. SliceModal then consumes the hook and must
  behave identically. This is the riskiest change in the whole program, so write the parity test for
  the hook BEFORE the extraction, and keep SliceModal working — it stays reachable as a fallback until
  the owner has tested this page on real hardware. Do not delete it.
- SlicerRail: printer/process selects, filament slot grid, build-plate select, then
  `ProcessSettingsEditor` — a new component rendering the curated fields from
  GET /slicer/process-fields over the values from GET /slicer/resolved-process, with search, the
  category chips from the field data's own categories, and Basic/Advanced tiers. It emits an override
  diff: only fields actually changed, and nothing when a value is set back to the resolved default.
  Overridden fields are visibly marked. State plainly that it covers a subset of the slicer's settings
  (~102 of 545+); do not imply completeness.
- PlateStage: read-only this step — orbit only, reusing ModelViewer. Plate tabs and the transform
  readout are in scope; gizmos arrive in step 8.
- Action bar: estimate, then Slice, then Print now. Slice goes through the existing slice-job dispatch
  and progress tracking. Print now hands the produced file to the existing PrintModal. Print now is
  enabled ONLY while the last completed slice still matches the current selections — any change to a
  preset, override or plate invalidates it, so it can never dispatch a print that doesn't match the
  screen.
- Point the inspector panel's Slice button at this route.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 6 — Mobile slicer wizard

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Step 5 (desktop slicer page) must already be merged into slicer-ux-redesign.

  git worktree add ../bambuddy-step-6 -b slicer-ux-redesign/step-6-mobile-wizard origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md — §6 (Mobile slicer wizard) and
§7 Step 6. Open frontend/mockups/slicer-ux-redesign.html, screen 2, phone option C. That is the
approved design — the owner chose it over bottom tabs and a draggable split.

Your task: on a phone, slicing walks the user through one decision at a time.

- Steps: Printer -> Filaments -> Settings -> Review. Progress dots. Per-step validation gating Next.
- A model thumbnail persists across steps; the full viewport is one tap away from any step.
- Review shows the estimate and both Slice and Print now.
- IMPORTANT: when the file already has a sliced child, mount on Review with the previous slice's
  settings pre-filled, steps 1-3 reachable as editable chips. Without this, re-slicing an unchanged file
  costs four screens — it is the wizard's one real weakness and the reason this behaviour was specified.
- Same SlicerPage state as desktop; only the presentation differs. Switch on the existing useIsMobile().
  Do not fork the state logic.

Tests: on a phone viewport a never-sliced file opens at step 1 and reaches a successful slice; a
previously-sliced file opens on Review with prior settings and slices without visiting earlier steps.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 7 — Apply placement at slice time

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Step 4 (overrides) must already be merged into slicer-ux-redesign.

  git worktree add ../bambuddy-step-7 -b slicer-ux-redesign/step-7-placement-backend origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md — §4 (the plate_layout shape),
§3a item 5, §7 Step 7, and the two placement risks in §9. Read those risks before writing code; they
will change how you sequence the work.

Your task: a stored plate arrangement is applied to the model when it is sliced.

- GET and PUT /library/files/{id}/layout. Validate against the shape in §4; reject version != 1.
  Writing null clears the layout (reset to original).
- Apply the stored layout to the model bytes before they reach
  SlicerApiService.slice_with_profiles(). The sidecar takes bytes, so this is a byte-rewriting job.
  - 3MF: rewrite the build-item transform matrices. This is what the container is for.
  - STL: bake the matrix into the vertices.
- Do NOT reach for the CLI's --scale/--rotate flags. §3a item 5 measured them: they are global (one
  transform for the whole model, so they cannot express per-object placement) and they segfaulted on
  OrcaSlicer. That path is closed.

Settle this FIRST, before building the rest: does the slicer re-centre a translated STL and discard the
translation? Run it against a real sidecar. If it does, the fallback is wrapping the STL in a minimal
3MF on first placement — which also removes the STL special case entirely, so it may be the better
design regardless. Report what you found in the PR.

Also: test byte-rewritten 3MFs against BOTH sidecars, not just the configured default. OrcaSlicer's
model-transform path looks less exercised than BambuStudio's.

No UI in this step. Tests: a file with a stored non-identity layout slices to G-code whose first-layer
extents differ from the same file with no layout, in the expected direction; ThreeMFParser still parses
the rewritten 3MF with unchanged geometry counts.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```

---

## Step 8 — Interactive placement

```
You are working on the Bambuddy fork at git@github.com:jappyjan/bambuddy.git.
Steps 5 (slicer page) and 7 (placement backend) must both already be merged into slicer-ux-redesign.

  git worktree add ../bambuddy-step-8 -b slicer-ux-redesign/step-8-gizmos origin/slicer-ux-redesign

Read docs/superpowers/specs/2026-07-30-slicer-ux-redesign-design.md — §4 (plate_layout shape),
§6 (Desktop slicer layout) and §7 Step 8. Open frontend/mockups/slicer-ux-redesign.html, screen 2 —
the gizmo toolbar down the left of the stage and the transform readout bottom-right.

Your task: the user can move, rotate, scale and auto-arrange models on the plate, and the arrangement
is remembered.

- Add TransformControls to PlateStage. It ships in the three/examples/jsm/controls/ path the project
  already imports OrbitControls from — no new dependency.
- Gizmo toolbar: move, rotate, scale, lay flat, auto-arrange. Live transform readout with numeric entry.
- Save layout persists via PUT /library/files/{id}/layout using the shape in §4 — object_id must match
  the 3MF object ids ModelViewer already parses into ObjectData.id. Reset to original clears the layout.
- Reloading the page restores the arrangement, and slicing reflects it.
- Gizmo hit targets must be touch-sized: the mobile wizard's viewport uses this same component.

Tests: dragging a model updates the readout; Save persists; a reload restores; Reset returns the model
to its original transform.

Run ./test_backend.sh and ./test_frontend.sh, paste the output, then open a PR into slicer-ux-redesign.
```
