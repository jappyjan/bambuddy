#!/usr/bin/env bash
# Spike harness for ticket #22 — "does the slicer re-centre a translated STL?"
#
# Boots both sidecars, generates translated/untranslated models, slices them,
# and prints first-layer extents so placement survival can be read off directly.
# Reusable by #30 for testing byte-rewritten 3MFs against BOTH slicers.
#
#   ./run_spike.sh            # full run
#   PY=/opt/homebrew/bin/python3.14 ./run_spike.sh
#
# Needs the fork sidecar images pulled locally:
#   ghcr.io/jappyjan/orca-slicer-api:latest
#   ghcr.io/jappyjan/bambu-studio-api:latest
set -euo pipefail

PY="${PY:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$(mktemp -d)}"
ORCA_PORT="${ORCA_PORT:-13003}"
BAMBU_PORT="${BAMBU_PORT:-13004}"

PRINTER="${PRINTER:-Bambu Lab A1 0.4 nozzle}"
PROCESS="${PROCESS:-0.20mm Standard @BBL A1}"
FILAMENT="${FILAMENT:-Bambu PLA Basic @BBL A1}"

mkdir -p "$WORK/models" "$WORK/out"
cd "$WORK"

cleanup() { docker rm -f spike-orca spike-bambu >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> booting sidecars (workdir: $WORK)"
docker rm -f spike-orca spike-bambu >/dev/null 2>&1 || true
docker run --rm -d --name spike-orca  -p "${ORCA_PORT}:3000"  ghcr.io/jappyjan/orca-slicer-api:latest   >/dev/null
docker run --rm -d --name spike-bambu -p "${BAMBU_PORT}:3000" ghcr.io/jappyjan/bambu-studio-api:latest >/dev/null
sleep 20
docker logs spike-orca 2>&1 | tail -2
docker logs spike-bambu 2>&1 | tail -2

echo "==> resolving bundled profiles"
# The sidecar serves only an index of bundled presets, not resolved JSON, so we
# pull the BBL tree out of the image and flatten the `inherits` chain ourselves.
docker cp spike-orca:/app/squashfs-root/resources/profiles/BBL ./BBL >/dev/null
"$PY" "$HERE/resolve.py" machine  "$PRINTER"  > out/printer.json
"$PY" "$HERE/resolve.py" process  "$PROCESS"  > out/process.json
"$PY" "$HERE/resolve.py" filament "$FILAMENT" > out/filament.json

echo "==> generating models"
"$PY" "$HERE/mkstl.py" models

slice_one() { # slice_one <model-file> <port> <tag>
  local model="$1" port="$2" tag="$3" ctype=model/stl
  [[ "$model" == *.3mf ]] && ctype=model/3mf
  local code
  code=$(curl -s -o "out/${tag}.gcode" -w "%{http_code}" \
    -F "file=@${model};type=${ctype}" \
    -F "printerProfile=@out/printer.json;type=application/json" \
    -F "presetProfile=@out/process.json;type=application/json" \
    -F "filamentProfile=@out/filament.json;type=application/json" \
    "http://localhost:${port}/slice")
  echo "  ${tag}: HTTP ${code}"
  [[ "$code" == 200 ]] || head -c 300 "out/${tag}.gcode"
}

echo "==> slicing STLs (the question: do a_center and b_translated differ?)"
for m in a_center b_translated c_pair d_pair_moved; do
  slice_one "models/${m}.stl" "$ORCA_PORT"  "${m}_orca"
  slice_one "models/${m}.stl" "$BAMBU_PORT" "${m}_bambu"
done

echo "==> exporting a real project 3MF, then rewriting its transform by (+40,+25)"
curl -s -o out/exported_orca.3mf \
  -F "file=@models/a_center.stl;type=model/stl" \
  -F "printerProfile=@out/printer.json;type=application/json" \
  -F "presetProfile=@out/process.json;type=application/json" \
  -F "filamentProfile=@out/filament.json;type=application/json" \
  -F "exportType=3mf" "http://localhost:${ORCA_PORT}/slice"
cp out/exported_orca.3mf models/r_orig.3mf
"$PY" "$HERE/rewrite3mf.py" out/exported_orca.3mf models/r_both.3mf 40 25 both
for m in r_orig r_both; do
  slice_one "models/${m}.3mf" "$ORCA_PORT"  "${m}_orca"
  slice_one "models/${m}.3mf" "$BAMBU_PORT" "${m}_bambu"
done

echo
echo "==> first-layer extents"
echo "--- STL: identical extents means the translation was discarded ---"
"$PY" "$HERE/extents.py" out/a_center_orca.gcode out/b_translated_orca.gcode \
                         out/a_center_bambu.gcode out/b_translated_bambu.gcode
echo "--- STL, multi-solid: bbox centre is snapped to bed centre ---"
"$PY" "$HERE/extents.py" out/c_pair_orca.gcode out/d_pair_moved_orca.gcode \
                         out/c_pair_bambu.gcode out/d_pair_moved_bambu.gcode
echo "--- project 3MF: rewritten transform should shift the centre by (+40,+25) ---"
"$PY" "$HERE/extents.py" out/r_orig_orca.gcode out/r_both_orca.gcode \
                         out/r_orig_bambu.gcode out/r_both_bambu.gcode
echo
echo "artifacts left in $WORK"
