#!/usr/bin/env bash
# Dual-sidecar check for ticket #30 — "apply the stored plate_layout to the
# model bytes before dispatch".
#
# Unlike run_spike.sh (which used throwaway rewriters to answer #22's
# question), this drives the *shipped* code path:
# backend/app/services/plate_layout.{ensure_project_3mf,apply_plate_layout}.
# It slices the same model with and without a stored layout on BOTH sidecars
# and prints first-layer extents so the placement can be read off directly.
#
#   ./run_layout_check.sh
#   PY=/opt/homebrew/bin/python3.14 ./run_layout_check.sh
#
# Needs the fork sidecar images pulled locally:
#   ghcr.io/jappyjan/orca-slicer-api:latest
#   ghcr.io/jappyjan/bambu-studio-api:latest
set -euo pipefail

PY="${PY:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$(mktemp -d)}"
export PYTHONPATH="$HERE"
ORCA_PORT="${ORCA_PORT:-13005}"
BAMBU_PORT="${BAMBU_PORT:-13006}"

PRINTER="${PRINTER:-Bambu Lab A1 0.4 nozzle}"
PROCESS="${PROCESS:-0.20mm Standard @BBL A1}"
FILAMENT="${FILAMENT:-Bambu PLA Basic @BBL A1}"

mkdir -p "$WORK/models" "$WORK/out"
cd "$WORK"

cleanup() { docker rm -f layout-orca layout-bambu >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> booting both sidecars (workdir: $WORK)"
docker rm -f layout-orca layout-bambu >/dev/null 2>&1 || true
docker run --rm -d --name layout-orca  -p "${ORCA_PORT}:3000"  ghcr.io/jappyjan/orca-slicer-api:latest   >/dev/null
docker run --rm -d --name layout-bambu -p "${BAMBU_PORT}:3000" ghcr.io/jappyjan/bambu-studio-api:latest >/dev/null
sleep 20

echo "==> resolving bundled profiles"
docker cp layout-orca:/app/squashfs-root/resources/profiles/BBL ./BBL >/dev/null
"$PY" "$HERE/resolve.py" machine  "$PRINTER"  > out/printer.json
"$PY" "$HERE/resolve.py" process  "$PROCESS"  > out/process.json
"$PY" "$HERE/resolve.py" filament "$FILAMENT" > out/filament.json

echo "==> generating models (an L of three cubes: asymmetric, so a rotation's sign shows)"
"$PY" "$HERE/mklmodel.py" models/l_shape.stl

slice_one() { # slice_one <model> <port> <tag> [exportType]
  local model="$1" port="$2" tag="$3" export="${4:-}" ctype=model/stl
  local extra=()
  [[ "$model" == *.3mf ]] && ctype=model/3mf
  [[ -n "$export" ]] && extra=(-F "exportType=3mf")
  local out="out/${tag}.gcode"
  [[ -n "$export" ]] && out="out/${tag}.3mf"
  local code
  code=$(curl -s -o "$out" -w "%{http_code}" \
    -F "file=@${model};type=${ctype}" \
    -F "printerProfile=@out/printer.json;type=application/json" \
    -F "presetProfile=@out/process.json;type=application/json" \
    -F "filamentProfile=@out/filament.json;type=application/json" \
    ${extra[@]+"${extra[@]}"} "http://localhost:${port}/slice")
  echo "  ${tag}: HTTP ${code}"
  [[ "$code" == 200 ]] || head -c 400 "$out"
}

for slicer in orca bambu; do
  port=$ORCA_PORT; [[ $slicer == bambu ]] && port=$BAMBU_PORT
  echo
  echo "==================== ${slicer} ===================="
  echo "==> baseline: STL sliced with no layout"
  slice_one models/l_shape.stl "$port" "base_${slicer}"

  echo "==> ensure_project_3mf: STL -> project 3MF via THIS sidecar"
  slice_one models/l_shape.stl "$port" "conv_${slicer}" export
  "$PY" "$HERE/applylayout.py" "out/conv_${slicer}.3mf" "models/moved_${slicer}.3mf" move
  "$PY" "$HERE/applylayout.py" "out/conv_${slicer}.3mf" "models/rotp_${slicer}.3mf" rot+30
  "$PY" "$HERE/applylayout.py" "out/conv_${slicer}.3mf" "models/rotm_${slicer}.3mf" rot-30
  cp "out/conv_${slicer}.3mf" "models/orig_${slicer}.3mf"

  echo "==> slicing: unmodified project 3MF, moved, rotated +30, rotated -30"
  for m in orig moved rotp rotm; do
    slice_one "models/${m}_${slicer}.3mf" "$port" "${m}_${slicer}"
  done
done

echo
echo "==> first-layer extents"
echo "--- OrcaSlicer ---"
"$PY" "$HERE/extents.py" out/base_orca.gcode out/orig_orca.gcode out/moved_orca.gcode out/rotp_orca.gcode out/rotm_orca.gcode
echo "--- BambuStudio ---"
"$PY" "$HERE/extents.py" out/base_bambu.gcode out/orig_bambu.gcode out/moved_bambu.gcode out/rotp_bambu.gcode out/rotm_bambu.gcode
echo
echo "==> expected (analytic, from the L-shape footprint)"
"$PY" "$HERE/applylayout.py" --expect
echo
echo "artifacts left in $WORK"
