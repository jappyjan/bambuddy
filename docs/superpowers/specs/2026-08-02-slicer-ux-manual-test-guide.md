# Slicer UX redesign — manual test guide

**Branch:** `slicer-ux-redesign` · **Covers:** all ten steps of `2026-07-30-slicer-ux-redesign-design.md`
**Purpose:** gate the fork before anything is proposed upstream. Run against a deployed test instance with real printers.

Walk this as a journey, not a ticket list — browse → inspect → slice → place → print → find the output grouped under its source. Sections build on each other; where a failure means "don't bother with the rest", it says so.

Most of what follows is obvious when it breaks. The parts marked **⚠ silent failure** are not — they look like success. Those are why a human runs this and a test suite does not.

---

## 0. Before you start

### Have ready

| Item | Why |
|---|---|
| A **project 3MF** (BambuStudio/OrcaSlicer export, single object) | The baseline happy path |
| A **multi-object 3MF** (2+ objects on one plate) | The only file that can catch a placement bug — the applier deliberately forgives a lone object, so a single-object file passes either way |
| A **multi-plate 3MF** | The side-by-side plate grid, per-plate layout |
| An **STL** | Non-project files take a different, slower route (§5.3) |
| A **non-project 3MF** (Fusion/Blender export) if you have one | Same route as the STL |
| A **file sliced before this branch** | No backfill was done, on purpose (§1.3) |
| **At least one real printer**, online, plate loaded | Print now dispatches for real |
| **A configured slicer sidecar** — see below | Half the epic is invisible without it |
| A **phone**, or a viewport under **768 px** | §8. That is the exact breakpoint |
| A **junk folder** of throwaway files | §9 deletes things |

### Confirm the sidecar (do not skip)

`/schema` only exists in the `ghcr.io/jappyjan/*` images. **`slicer-api/docker-compose.yml` in this repo still pins `ghcr.io/maziggy/*`** — if you deployed from it unchanged you are on the old sidecar, and §4 will test nothing.

There is no proxy for this in the app; curl the sidecar directly.

```sh
curl -s http://<host>:3001/schema | jq '{slicer, version, keys: (.keys|length)}'   # BambuStudio
curl -s http://<host>:3003/schema | jq '{slicer, version, keys: (.keys|length)}'   # OrcaSlicer
```

- [ ] **Pass:** `{slicer, version, keys, defaults}`, key count ≈ **545** (BambuStudio 02.07.01.57) / **572** (OrcaSlicer 2.3.2).
- [ ] **Fail:** `404` / `Cannot GET /schema` → old image. Repoint at `ghcr.io/jappyjan/bambu-studio-api` / `ghcr.io/jappyjan/orca-slicer-api` (`docker login ghcr.io` with a `read:packages` token — both packages are private) and redeploy first.

Then confirm which one Bambuddy is actually pointed at: **Settings → Slicer** shows the URL for the preferred slicer (a plain editable field — no test button, no version, no reachability light; that gap is worth noting in itself).

Record: sidecar URL `________________` · slicer `__________` · version `__________`

---

## Stop immediately if

Stop and report. Do not continue, do not merge.

- [ ] **Files disappear that you did not select** — especially after a bulk delete (§9).
- [ ] **A print dispatches to a printer you did not choose.**
- [ ] **Print now stays enabled after you change something, and dispatches.** That is a print that does not match the screen (§6). Cancel it at the printer.
- [ ] **Deleting a source file also removes its sliced children.** The FK is `ON DELETE SET NULL` precisely so this cannot happen.
- [ ] **Print now hands over the source model instead of the sliced output.**
- [ ] **Save layout writes to the wrong file**, or a layout appears on a file you never arranged.

---

## 1. Browse the library

**File Manager**, grid view.

### 1.1 Sliced outputs nest under their source

- [ ] A file sliced on this branch shows an **expand chevron** left of the filename and a green **slice-count pill** with a layers icon (hover: `Sliced outputs: N`).
- [ ] The chevron inserts the children **directly below, indented with a blue left border**, each with a green `SLICED` badge.
- [ ] Clicking the chevron does **not** select the card, and the rest of the grid does **not** reorder. Sort and filter act on parents.
- [ ] Nesting is one level deep — a child never gets its own chevron.

**⚠ Silent failure — a stale badge.** The pill counts the server-derived `slice_count`, not the children on screen. Trash one slice and confirm the pill **decrements**. If it doesn't, the count is coming from the rendered children and you will go looking for output that no longer exists.

**Also check — nesting is grid-only:**

- [ ] Switch to **list view**: every sliced file appears as its own row. If children vanish there, nesting has leaked into the flat listing and those files are invisible to select-all and bulk print.
- [ ] A slice whose **source is in a different folder** (move one) renders as an ordinary top-level card in the folder you are viewing. Nesting only happens when the parent is on the same page.
- [ ] A **slice of a slice** stays top-level rather than disappearing.

### 1.2 Deleting a source does not destroy its slices

Junk files only.

- [ ] Slice a junk file, then trash **and permanently delete the source**.
- [ ] The sliced output is still present, now an ordinary top-level card.

If the slice went with it, **stop**.

> On SQLite the null-out is done by the ORM, not the database. Two bulk paths bypass it — the trash sweeper and user deletion. If you exercise either, re-check that the surviving slices still render (an orphaned parent id can leave a child pointing at a row that no longer exists).

### 1.3 Old sliced files still appear

- [ ] Find a file sliced before this branch. It renders as a **normal top-level card** — no chevron, no count pill, no error state, no orphan bucket.

There was deliberately no backfill; those rows have no parent and never will. Hidden, mis-grouped, or grouped by filename guesswork is the bug.

> **Known cosmetic inconsistency, not a bug to chase:** the `SLICED` badge shows on a *card* only for a nested child, but the *inspector* shows it for any sliced-looking filename. Note it, move on.

> **If §1 fails, stop here.** Everything downstream is verified against grouping.

---

## 2. Inspect a file

Click a file card (not the hover buttons).

- [ ] A panel opens **docked on the right**; the grid reflows from 5–6 columns to 3–4. Nothing navigates, no modal.
- [ ] It shows: title, size, plate count, upload date, print count, print time, tags (or `None`), a square preview with a **3D preview** overlay, and a full-width action stack — **Slice & Print** (green), **Add to queue**, **Download**, **Rename**, **Delete**.
- [ ] Actions you lack permission for are **absent**, not greyed out.
- [ ] The `X` closes it and the grid returns to full width.

This must be **mockup screen 1, option A** — a docked right-hand panel. If the card *expands in place* into a full-width row (option B), or the app *navigates to a detail screen* (option C), the wrong design was built.

> The **Dimensions** row is implemented but nothing feeds it today, so it does not appear. Expected, not a failure.

### 2.1 ⚠ Silent failure: the panel must update in place

- [ ] Click through five files quickly. The content changes each time with **no flash, no collapse-and-reopen, no spinner sweep, no URL change**.

Why it matters: in-place update is the entire reason this layout beat a detail page. A remount looks near-identical at normal speed but makes skimming a folder feel like navigating, and throws away panel scroll position. Watch the panel border for a blink.

- [ ] Clicking a second file **sets** the panel, never toggles it shut. Only the `X` closes it.
- [ ] Click a **nested sliced child** — it inspects exactly like a top-level file.
- [ ] Rename a file with its panel open — the new name flows through without reopening.
- [ ] Delete the inspected file, or filter it out of view — the panel **closes** rather than showing a ghost.

### 2.2 Phone: bottom sheet

- [ ] Tapping a file raises a **bottom sheet at ~60%** showing title, metadata and the top of the action stack.
- [ ] Dragging the **grabber strip** up snaps to full screen. Down goes full → peek → dismissed. One careless swipe from full must **not** dismiss it.
- [ ] The backdrop dismisses from either height.
- [ ] The panel body scrolls normally — only the grabber resizes the sheet.

---

## 3. Open the slicer

From the inspector: **Slice & Print**.

- [ ] URL becomes `/slicer?file=<id>`. Not a modal.
- [ ] Refresh keeps you on the file; browser **Back** returns where you came from.
- [ ] Layout: settings rail left, dominant 3D stage, action bar along the bottom **inside** the stage — mockup screen 2.
- [ ] `/slicer` with no valid param shows *"No file to slice. Open a file in the File Manager and choose Slice."* plus **Back to files**. (`?file=abc`, `?file=0`, `?file=-3` all land here — correct.)
- [ ] `/slicer?archive=<id>` opens against an archive. This is **deep-link only**; no button produces it.

**Not a bug:** the **hover Slice button on a file card still opens the old `SliceModal`**. Only the inspector's button routes to the new page, deliberately, until you sign this off. Do report it if the two produce *different* results for the same selections.

### 3.1 The rail

Top to bottom: **Profiles** heading + Refresh, Printer profile, (optional) *Use the file's built-in settings*, Process profile, Build plate, filament slots, then the settings editor.

- [ ] Presets are pre-picked the same way the old modal pre-picked them.
- [ ] Re-opening the same file reproduces the same selection every time.
- [ ] Slots the plate does not use are labelled *"— not used by this plate"* and disabled.
- [ ] Ticking **Use the file's built-in settings** disables the printer/process/plate/filament dropdowns **and the whole settings editor**.

**⚠ Silent failure — the pre-pick.** `useSlicePresets` was extracted out of `SliceModal` and is now shared by both. A wrong extraction shows up as a *plausible but different* default — a different filament slot, or a merely-compatible printer instead of the right one. Open the same file in the old modal (hover Slice) and the new page side by side and compare **slot for slot**. This is the riskiest change in the epic and it fails by looking reasonable.

---

## 4. Override a setting

Rail, below the presets: **Print settings**.

- [ ] Header reads *"N curated settings — a subset of the slicer's 545+, not the full list."* It must say this out loud — the editor covers ~101 of 545+. Expect **101** on OrcaSlicer, **94** on BambuStudio (7 fields are OrcaSlicer-only and hidden).
- [ ] **Basic / Advanced** tiers (Basic is a 17-field shortlist), a search box, category chips (Quality, Strength, Speed, Support, Infill, Adhesion, Acceleration, Multi-material, Advanced, Special) with **All** first.
- [ ] Searching finds an Advanced-only field **while Basic is selected** — search bypasses the tier filter.
- [ ] Changing a value gives the row an **amber dot**, an amber tint, and a per-field revert (*"Back to the preset value (…)"*).
- [ ] Footer reads `N changed` in amber; with nothing changed, `Preset values`. **Reset** clears everything.
- [ ] Set a field, then set it **back** to the preset value — the count returns to zero and the dot clears. A value returned to its default must never be sent as an override.
- [ ] Number fields commit on **blur or Enter**, clamp to min/max, and clearing the box means "back to the preset value", not zero.

### 4.1 ⚠ Silent failure: overrides that do nothing

Spend time here. Three independent ways an override gets accepted and then quietly ignored.

**(a) The value reaches the slicer in a form its config parser rejects.** A raw JSON number (`25` rather than `"25%"`) is logged and discarded by the CLI, which carries on with the preset default — HTTP 200, no error, no change. The backend coerces values to the string spelling to prevent this; that coercion is the only thing making overrides work at all.

**(b) The key does not exist in the running slicer.** Validation is against the sidecar's real key set from `/schema`.

**(c) You are silently in fallback mode.** When `/schema` is unreachable — an old `maziggy` image 404s, or the sidecar is down — validation falls back to the curated file's own key list. **Nothing in the UI or the API tells you.** `/slicer/process-fields` never contacts the sidecar at all and carries no source flag; the settings list looks identical either way. The only evidence is one line in the app log:

```
Slicer /schema unavailable at <url> (<err>) — validating process_overrides against the curated key list instead
```

- [ ] After your first slice with an override, grep the backend log for `schema unavailable`. Absent = you are validating against the real slicer. Present = §0 was not done properly; fix and redo §4.

**Prove it end to end — do not trust the amber dot:**

- [ ] Slice once with **no** overrides. Note the estimate.
- [ ] Search **Infill Density**. Set it to something unmissable — **5%** if the preset is high, **100%** if it is low. Also set **Wall Loops** to 6.
- [ ] Slice. The **time/filament estimate must change substantially.**
- [ ] Better: download both G-code outputs and confirm the config header genuinely differs — `; sparse_infill_density = 5%`, `; wall_loops = 6`.

Identical estimate = the override did nothing, whatever the UI showed.

### 4.2 Invalid overrides must be loud

Validation is all-or-nothing and every problem comes back in one 422, joined by `; `. Messages read like:

- `'foo' is not a setting bambu_studio has`
- `'x' has no curated metadata and cannot be overridden`
- `'layer_height' must be at most 0.6mm — got 5`

- [ ] If you run both sidecars, repeat one override against the **other** slicer. Only 394 of the two key sets are shared; an OrcaSlicer-only field must come back as a readable 422 on BambuStudio, **never a silent drop**.
- [ ] **Bed type still works as its own control** — it is not folded into the overrides and is applied last, so it wins. Change the build plate and confirm the output reflects it. (`curr_bed_type` inside `process_overrides` is now rejected; that is intended.)

---

## 5. Place the model on the plate

On the stage.

- [ ] **Gizmo toolbar**, vertical, overlaid top-left: **Move**, **Rotate**, **Scale**, **Lay flat**, **Auto-arrange**. The first three are modes; Move is the default. All five need a selection (Auto-arrange needs objects).
- [ ] **All plates side by side** on one floor, 3 across and wrapping to further rows, each on its own bed — only when the file has more than one plate. Orbit and pan across them.
- [ ] Each plate carries its **name as a label above its bed** and a **`01`-style number** at its near-right corner, both following the camera as you orbit.
- [ ] **Clicking a plate's bed or its label makes it active**; the active plate's bed is tinted green while the rest stay grey. Slice targets the active plate.
- [ ] Clicking an object standing on a *different* plate selects that object **and** makes its plate active.
- [ ] **On a phone the stage still shows one plate at a time**, with the plate names as a strip along the top edge — deliberately not the grid.
- [ ] **Object picker** top-right — only when the plate has more than one object.
- [ ] **Transform readout** bottom-right: **Position** (mm), **Rotation** (°), **Scale** (%), three editable number inputs each, committing on blur/Enter. Scale is shown as a percentage.
- [ ] Dragging a gizmo handle moves the model and updates the readout live. **The camera must not orbit while you drag a handle.**
- [ ] Lay flat drops the object onto the bed; Auto-arrange spreads objects without overlap.
- [ ] Handles and buttons are finger-sized on a phone.

### 5.1 Saving and restoring

Action bar, left to right: **Reset layout**, **Save layout**, **Slice**, **Print now**, with the estimate to their left.

- [ ] **Save layout** → toast *"Layout saved"*. Reload the page — the arrangement is still there.
- [ ] **Reset layout** → toast *"Layout reset to the original arrangement"*, objects back as designed. **There is no confirmation dialog** — it fires immediately. Decide whether that is acceptable and note it either way.
- [ ] Reset is offered for a file arranged in a *previous* session, without touching anything first.
- [ ] With nothing moved, Save is disabled: *"The plate already matches the saved arrangement."*
- [ ] For an **archive** source both buttons explain *"Arrangements can only be saved for library files."* and the stage is fully read-only — no gizmo toolbar, and the readout is text rather than inputs. Archives have no layout endpoint, so a gizmo there could not change the print.

### 5.2 ⚠ Silent failure: placement accepted, stored, then dropped

**Use the multi-object 3MF.** A single-object file cannot catch this: when there is exactly one build item and exactly one placement, the applier matches them regardless of identifier. With two objects, addressing them by the wrong identifier produces a layout that saves, echoes back, restores on screen — and matches nothing at slice time. The slice then succeeds, **unarranged**, with only a log warning.

- [ ] Move **both** objects to obviously different, asymmetric positions (front-left corner and back-right). **Rotate one by 30°** — a symmetric or axis-aligned model will not reveal a mirrored rotation convention.
- [ ] Save, reload, confirm the stage restores both.
- [ ] Slice, then open the output. **Both** objects must be where you put them — not both re-centred, not one moved and one not, not mirrored.
- [ ] Check the backend log for `none of the ... placement(s) matched a build item`. That warning is the whole failure, and it is the only thing that reports it.

### 5.3 ⚠ Placement on STL vs 3MF

Spec §9 flagged this; the spike settled it by measurement. **Both slicers unconditionally re-centre a bare mesh**, so a transform baked into STL vertices is discarded, and BambuStudio additionally auto-rotates. So does a hand-rolled minimal 3MF. The shipped answer: anything that is not already a *project* 3MF (an STL, or a core-spec 3MF from Fusion/Blender) is first converted into one by the same sidecar that will slice it, then goes down the normal path.

- [ ] **Project 3MF:** move well off centre, save, slice → the offset survives.
- [ ] **STL:** same move, save, slice → the offset survives **equally**. An STL that comes back centred while the 3MF did not means the conversion step is not running and STL placement is a silent no-op.
- [ ] **Non-project 3MF** (Fusion/Blender), if you have one — same path, same expectation.
- [ ] Expect the STL / non-project slice to be **noticeably slower**: the conversion costs one extra *full* sidecar slice, because the CLI has no export-only mode. Slow is expected; centred is a bug.
- [ ] If you run both sidecars, repeat the STL case on each. The embedded config is slicer-specific — a BambuStudio export fed to OrcaSlicer fails outright (exit 238). You want to see it fail loudly, not silently produce a re-centred print.

### 5.4 Slicing must not use a stale layout

- [ ] Move an object but **do not** press Save. Press **Slice**. The slice must use what is on screen — the pending layout is flushed first.
- [ ] If the layout write fails, the slice must **abort with an error**, not proceed with the previous arrangement.

Nothing about the layout travels on the slice request; the backend reads the stored column. An unflushed move would slice the *old* arrangement while the viewport showed the new one.

### 5.5 Known limits — confirm, don't report

- **Multi-plate layouts are merged.** Placements from every plate collapse into one flat map keyed by object id, so you cannot store two different transforms for the same object across two plates — the lower-numbered plate wins. Only matters for a file that repeats an object id across plates.
- **Archives can never have a layout** via the UI or API; the column exists but nothing writes it.
- **No caching of converted bytes** — every slice of an STL with a layout pays the extra round-trip again.

---

## 6. ⚠ Print now must never dispatch a stale slice

The most important check here. **Print now** is gated on a fingerprint of the whole slice request *plus* the stage layout, so anything that changes what would be sliced disables it by construction. If that leaks, the button prints something other than what is on screen, on real hardware, with real filament.

The label never changes; the tell is the disabled state plus the hover text, and — after a slice has completed — an **amber line under the bar**.

Baseline:

- [ ] No slice yet → **Print now** disabled, hover: *"Slice the model first."* No amber line.
- [ ] Slice successfully → enabled, hover: *"Send the sliced file straight to a printer"*.

Now break it, one input at a time. **After each, Print now must go disabled** and the amber line must read *"Settings changed since the last slice — slice again before printing."*

- [ ] Change the **printer**
- [ ] Change the **process profile**
- [ ] Change a **filament slot**
- [ ] Change the **build plate / bed type**
- [ ] Toggle **Use the file's built-in settings**
- [ ] Change a **process override**
- [ ] Switch the **active plate**
- [ ] **Move, rotate or scale** an object on the stage

Recovery:

- [ ] **Undo** the change — set the value back to exactly what it was. Print now re-enables **without re-slicing**. If it stays disabled the fingerprint is unstable; if a *different* value re-enables it, the fingerprint is not covering that input.
- [ ] **Save layout** on an unchanged plate, and **re-click Auto-arrange** on an already-arranged plate: neither may stale a still-valid slice.
- [ ] Re-slice after a real change → enabled again.
- [ ] Reorder nothing, just retype an override value in a different order — same fingerprint, still enabled.

**⚠ The subtle one: the gizmo drag.** The transform is deliberately owned by the page, not the viewport, exactly so it feeds the fingerprint. If the model moves on screen and Print now **stays lit**, the stage has gone back to holding its own state — the print goes out with the old arrangement and nothing on screen says so.

- [ ] On a phone, a **previously-sliced** file opens on Review (§8.1) with **Print now disabled**. Having been sliced before says nothing about whether that output matches what is on screen now.

---

## 7. Print, then come back

- [ ] Press **Print now**. The print dialog opens against the **sliced output** — check the filename; it must not be the source model.
- [ ] Choose the printer you expect, confirm. Toast: *"Print queued"*.
- [ ] The print starts on **that** printer. Anywhere else → **stop**.
- [ ] You never had to return to the file manager.

Then:

- [ ] Back in the File Manager, the new output is **nested under the file you sliced**, and the parent's count went up by one.
- [ ] Slice the same file again with different settings → two children under one parent.

That round trip is the whole epic. If it completes, the feature works.

---

## 8. On a phone

Under 768 px, open a file's inspector and press **Slice & Print**.

- [ ] It renders as a **guided wizard**, not the desktop rail. This is mockup phone **option C** — bottom tabs (A) or a draggable split (B) would be the wrong build.
- [ ] Header: back arrow, and **"Step 1 of 4"** top-right, plus four progress dots.
- [ ] Steps titled *"Which printer?"* → *"Which filaments?"* → *"Any adjustments?"* → *"Ready to slice"*.
- [ ] A **model thumbnail** persists across steps. Tapping it opens a full-screen 3D view — the **same stage, gizmos included** — and closing returns you to the same step. On a multi-plate file the thumbnail follows the active plate.
- [ ] **Next is gated and says why**, in amber, not just greyed: no printer/process → *"Choose a printer and a process profile to continue."*; a slot unset → *"Choose a filament profile for every slot to continue."* Settings is always satisfiable.
- [ ] Review shows the estimate on its own line and the four buttons in a 2×2 grid — Save layout and Reset layout stay reachable.
- [ ] A **never-sliced** file opens on **step 1** and reaches a successful slice.
- [ ] The wizard and the desktop page slice the **same thing**: same file, same selections, compare the estimates. The wizard is a layout, not a second slicer.

### 8.1 ⚠ Review-first mount

- [ ] A file that already has a sliced child opens **straight on Review**, with chips under *"Your choices — tap to change"*: **Printer**, **Filaments** (`N of M slots set`), **Settings** (`N changed` / `Preset values`).
- [ ] Tapping a chip jumps to that step; from steps 1 and 2 a **"Back to review"** button returns.
- [ ] It must land on Review **immediately**. You may see a brief *Loading…* spinner instead of the wizard — that is correct: the step is fixed at mount, so the page withholds the wizard until it knows. What must **never** happen is opening on step 1 and jumping to Review a moment later; if the step moves after you have already tapped Next, you lose what you just did.
- [ ] Trash **all** of a file's slices, then reopen on a phone — it is a never-sliced file again and starts at step 1. The count excludes trashed children.
- [ ] An **archive** always opens at step 1 — it has no slice count. Expected.

---

## 9. Cross-folder selection (destructive — junk files only)

Selection survives a folder change, a search and a tag filter. It always did; what was missing was the UI saying so, and bulk delete was destroying files the user could no longer see, with no undo.

- [ ] In Folder A, select two files → `2 selected`.
- [ ] Navigate to Folder B **without clearing**. An **amber pill** appears beside the count: `2 not in this view`. Always on screen — no hover, no expand.
- [ ] The toolbar stays mounted even when Folder B is **empty**. (If it vanishes there, the selection is live and invisible — the exact bug this fixed.)
- [ ] Same after typing in **search**, and after applying a **tag filter**.
- [ ] While a wider selection is live, select-all reads **"Select All in View"** and **unions** the visible listing into the selection rather than replacing it. The clear control reads **"Clear all N"** with the full count and clears everything, off-screen included.
- [ ] **Move** and **Tag** dialogs carry the same amber `N not in this view` pill.

### ⚠ The one that destroys data

- [ ] With a selection spanning both folders, press **Delete**.
- [ ] The confirmation is titled *"Delete N Files"* and, below the message, reads **"These files will be deleted:"** followed by a **scrollable list naming every file**.
- [ ] Each file **not** in the current view carries an amber *"not in this view"* chip; the visible ones do not.
- [ ] Rename a selected file first, then open the dialog — the list shows the **new** name for the visible one.
- [ ] Confirm, then check both folders: **exactly** the listed files are gone, on-screen and off. Nothing else.

A count alone ("12 selected") is not enough — the point is that you can read the names before agreeing. A single-file delete from a card keeps its plain message with no list; that is correct.

---

## 10. Sweep

- [ ] The **old `SliceModal`** still works from the card's hover Slice button and produces the same result as the page for the same selections.
- [ ] Slicing from elsewhere (queue, archives, pipelines) is unaffected.
- [ ] Nothing else in the File Manager broke in the refactor: folder tree, upload, move, rename, tags, thumbnails, external folders.
- [ ] Browser console: no errors across a full slice → place → print cycle.
- [ ] Switch locale — no raw i18n keys showing on the slicer page, wizard or settings editor (e.g. a literal `slicer.printNowStale`).
- [ ] Restart the backend and slice once more. The `/schema` cache is per-process and lives one hour; confirm the first slice after a restart still validates correctly.

---

## Results

Sidecar `________________` · Slicer/version `________________` · Date `__________` · Build/commit `__________`

| § | Area | Pass / Fail | Notes |
|---|---|---|---|
| 0 | Sidecar exposes `/schema` | | |
| 1.1 | Nested sliced outputs, badge decrements | | |
| 1.2 | Delete source keeps slices | | |
| 1.3 | Legacy slices with no parent | | |
| 2 | Inspector panel + **in-place update** | | |
| 2.2 | Phone bottom sheet | | |
| 3 | `/slicer` route and layout | | |
| 3.1 | **Preset pre-pick parity with the modal** | | |
| 4 | Settings editor UI | | |
| 4.1 | **Overrides genuinely change the output** | | |
| 4.1 | No `schema unavailable` in the log | | |
| 4.2 | Invalid override → readable 422 | | |
| 5.1 | Gizmos, save / reset / restore | | |
| 5.2 | **Multi-object placement survives slicing** | | |
| 5.3 | **STL placement survives slicing** | | |
| 5.4 | Unsaved layout flushed before slice | | |
| 6 | **Print-now staleness gate** (every input) | | |
| 7 | Print dispatch + regrouping | | |
| 8 | Mobile wizard | | |
| 8.1 | **Review-first mount** | | |
| 9 | **Cross-folder selection and delete** | | |
| 10 | Sweep | | |

**Verdict:** ☐ ready for upstream ☐ fix first ☐ blocked

Anything failing above is a fork-side fix. Nothing goes to `maziggy/*` until this sheet is clean.
