#!/bin/sh
# Step 1 of docs/plans/print-progress-match.md: during a print, saves what
# the printer reports about its progress, to compare with its screen.
#
#   scripts/measure-progress.sh <printer address> [port] [label]
#
# Run it at a few moments of a multi-colour print (start, first layer, a
# tool change, middle, end); the label names the moment ("start", "t2"…).
# Each run writes one folder under measures/progress/ (git-ignored):
#   objects.json   the list of Klipper objects;
#   status.json    print_stats, display_status, virtual_sdcard, gcode_move;
#   extra.json     a full query of every object that is not standard Klipper;
#   metadata.json  the job's metadata (estimated_time);
#   m73.txt        the M73 lines of the job's G-code (first ones).
# Write in screen.txt what the screen shows at that moment: percentage and
# time left. Needs curl and python3.
set -eu
host=${1:?usage: scripts/measure-progress.sh <printer address> [port] [label]}
port=${2:-7125}
label=${3:-}
b="http://$host:$port"
dir="measures/progress/$(date +%Y%m%d-%H%M%S)${label:+-$label}"
mkdir -p "$dir"

curl -fsS -m 6 "$b/printer/objects/list" > "$dir/objects.json"
curl -fsS -m 6 "$b/printer/objects/query?print_stats&display_status&virtual_sdcard&gcode_move" > "$dir/status.json"

# Objects of the U1 itself: every object not in this list of standard ones.
extra=$(python3 - "$dir/objects.json" <<'PY'
import json, sys, urllib.parse
std = ("print_stats display_status virtual_sdcard gcode_move toolhead heater_bed fan "
       "configfile webhooks motion_report query_endstops idle_timeout system_stats "
       "gcode_macro extruder heater_fan controller_fan temperature_sensor "
       "temperature_fan output_pin bed_mesh probe stepper_enable mcu exclude_object "
       "firmware_retraction pause_resume gcode").split()
objs = json.load(open(sys.argv[1]))["result"]["objects"]
# "extruder1", "tmc2209 stepper_x": a standard name, then digits or a section.
keep = [o for o in objs if not o.startswith("tmc") and not any(o.split()[0] == s or o.split()[0][len(s):].isdigit() and o.startswith(s) for s in std)]
print("&".join(urllib.parse.quote(o) for o in keep))
PY
)
[ -n "$extra" ] && curl -fsS -m 6 "$b/printer/objects/query?$extra" > "$dir/extra.json"

job=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["result"]["status"]["print_stats"]["filename"])' "$dir/status.json")
if [ -n "$job" ]; then
  enc=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$job")
  curl -fsS -m 6 "$b/server/files/metadata?filename=$enc" > "$dir/metadata.json" || true
  # The first megabytes are enough to see whether the slicer writes M73 P and R.
  curl -sS -m 30 -r 0-4000000 "$b/server/files/gcodes/$enc" 2>/dev/null | grep -m 20 '^M73' > "$dir/m73.txt" || true
fi
: > "$dir/screen.txt"
echo "Saved in $dir — write in $dir/screen.txt what the screen shows now."
