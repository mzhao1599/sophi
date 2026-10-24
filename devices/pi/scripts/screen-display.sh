#!/usr/bin/env bash
# Sets the Pi's display settings for the walker's 800x480 HDMI screen. Run by `install-pi.sh --screen`, or
# by hand: sudo ./scripts/screen-display.sh [--force-on | --remove] [boot folder, default /boot/firmware]
# Not yet run on the Pi (written 2026-10-23); test/screen-kiosk.test.ts runs it on copies of the stock files.
#
# Why these settings (devices/pi/README.md, "The screen"): a Pi 5 on Raspberry Pi OS trixie drives HDMI with
# the kernel's KMS driver, which ignores the old hdmi_group / hdmi_mode / hdmi_cvt lines in config.txt
# (Raspberry Pi's docs: those legacy options "don't work with Raspberry Pi OS Bookworm and later"). The KMS
# way to choose a resolution is a `video=` argument on the kernel command line, cmdline.txt. So this adds:
#   video=HDMI-A-1:800x480M@60   the port labelled HDMI0 (next to the USB-C power socket): 800x480 at 60 Hz,
#                                 with VESA CVT timings ("M"), the same timings Elecrow's own legacy
#                                 instructions ask for (hdmi_cvt 800 480 60 6 0 0 0)
#   video=HDMI-A-2:800x480M@60   the same for the port labelled HDMI1, in case the cable goes there
#   consoleblank=0                the text console never blanks (before the kiosk starts, or if it stops)
# It replaces any other video= for those two ports and any other consoleblank= (the old values stay in the
# backup), and records in sophi-screen-added.txt, next to cmdline.txt, which arguments it added that weren't
# there before. --remove takes out only those, so a consoleblank=0 you had already stays.
# With --force-on, HDMI0's entry ends in "D", which turns that output on even when the Pi doesn't see the
# panel's hot-plug signal; a later run without the flag keeps the "D".
# config.txt needs `dtoverlay=vc4-kms-v3d` (the KMS driver) and `disable_fw_kms_setup=1` (so the firmware
# doesn't pass its own video= from the panel's EDID), both in effect for every Pi model: before any [section]
# or under [all]. Stock Raspberry Pi OS has both there, so on a stock card config.txt isn't touched; if the
# second is missing, a marked block adds it at the end.
# It refuses (changing nothing) a cmdline.txt with no root= argument or more than one line, since the Pi reads
# only one line and a damaged cmdline.txt stops the Pi booting. Every file it changes is first copied to
# <file>.sophi-backup-<date and time>. Works with bash 3.2 (macOS, for the tests) and GNU bash on the Pi.
set -euo pipefail

mode=add
force=0
case "${1:-}" in
  --remove) mode=remove; shift ;;
  --force-on) force=1; shift ;;
esac
boot="${1:-/boot/firmware}"
config="$boot/config.txt"
cmdline="$boot/cmdline.txt"
record="$boot/sophi-screen-added.txt"
begin="# >>> Sophi screen: added by scripts/screen-display.sh (install-pi.sh --screen)"
end="# <<< Sophi screen"

# Every refusal is one line ending in "Nothing was changed.", which install-pi.sh shows as the reason.
refuse() {
  echo "$1 Nothing was changed." >&2
  exit 1
}

trim() { local s="$1"; s="${s%$'\r'}"; s="${s#"${s%%[![:space:]]*}"}"; printf '%s' "${s%"${s##*[![:space:]]}"}"; }

# True if config text $2 has the line $1, uncommented, before any [section] or under [all].
in_all_section() {
  local want="$1" section=all line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    case "$line" in
      "[all]") section=all ;;
      "["*"]") section=other ;;
      *) if [[ "$section" == all && "$line" == "$want" ]]; then return 0; fi ;;
    esac
  done <<<"$2"
  return 1
}

contains() {
  local want="$1" item
  shift
  for item in "$@"; do
    if [[ "$item" == "$want" ]]; then return 0; fi
  done
  return 1
}

for f in "$config" "$cmdline"; do
  [[ -f "$f" ]] || refuse "No $f: is this a Raspberry Pi OS boot partition?"
done

config_text="$(cat "$config"; printf x)"
config_text="${config_text%x}"
cmdline_text="$(cat "$cmdline"; printf x)"
cmdline_text="${cmdline_text%x}"

lines=0
first=""
while IFS= read -r line || [[ -n "$line" ]]; do
  line="$(trim "$line")"
  if [[ -z "$line" ]]; then continue; fi
  lines=$((lines + 1))
  if [[ $lines == 1 ]]; then first="$line"; fi
done <<<"$cmdline_text"
(( lines <= 1 )) || refuse "$cmdline has $lines lines; the Pi reads it as one line, so fix it by hand first."
tokens=()
read -r -a tokens <<<"$first" || true
has_root=0
for t in ${tokens[@]+"${tokens[@]}"}; do
  if [[ "$t" == root=* ]]; then has_root=1; fi
done
(( has_root )) || refuse "$cmdline has no root= argument, so it doesn't look like the Pi's kernel command line."

if [[ "$mode" == add ]] && ! in_all_section "dtoverlay=vc4-kms-v3d" "$config_text"; then
  refuse "$config has no 'dtoverlay=vc4-kms-v3d' for all models; the screen needs that KMS display driver, which stock Raspberry Pi OS turns on."
fi

stamp="$(date +%Y%m%d-%H%M%S)"
changed=0
# Writes $2 to file $1 if it differs, backing the file up first. The new text goes to a temporary file in the
# same folder, is renamed over the old one, and is synced to the card. That makes a half-written file unlikely,
# though the boot partition (FAT) has no journal, so a power cut at the wrong moment could still damage it:
# the backup is there for that.
replace_if_changed() {
  local file="$1" text="$2"
  if [[ "$(cat "$file"; printf x)" == "${text}x" ]]; then return 0; fi
  # Never overwrite an earlier backup, even from a run in the same second.
  local backup="$file.sophi-backup-$stamp" n=2
  while [[ -e "$backup" ]]; do backup="$file.sophi-backup-$stamp-$n"; n=$((n + 1)); done
  cp -p "$file" "$backup"
  printf '%s' "$text" >"$file.sophi-new"
  mv -f "$file.sophi-new" "$file"
  sync
  echo "Changed $file (the old one is $backup)."
  changed=1
}

# config.txt: the file without any earlier block of ours (or exactly as it is, if it has none)...
new_config="$config_text"
if grep -qxF "$begin" "$config"; then
  new_config=""
  inside=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$begin" ]]; then inside=1; continue; fi
    if [[ $inside == 1 ]]; then
      if [[ "$line" == "$end" ]]; then inside=0; fi
      continue
    fi
    new_config+="$line"$'\n'
  done <"$config"
fi
# ...plus a block, only when the setting isn't in effect for every model outside it.
if [[ "$mode" == add ]] && ! in_all_section "disable_fw_kms_setup=1" "$new_config"; then
  [[ -n "$new_config" && "$new_config" != *$'\n' ]] && new_config+=$'\n'
  new_config+="$begin"$'\n'"[all]"$'\n'
  new_config+="# Don't let the firmware pass its own video= from the panel's EDID: cmdline.txt's video= decides."$'\n'
  new_config+="disable_fw_kms_setup=1"$'\n'"$end"$'\n'
fi
replace_if_changed "$config" "$new_config"

# Old firmware-era lines that do nothing here (and Elecrow's ads7846 line is for a different, SPI touch chip).
if grep -qE '^[[:space:]]*(hdmi_cvt|hdmi_group|hdmi_mode|dtoverlay=ads7846)' "$config"; then
  echo "Note: $config has hdmi_cvt / hdmi_group / hdmi_mode or dtoverlay=ads7846 lines. The first three do"
  echo "nothing with the KMS driver; ads7846 is a resistive SPI touch chip, not this screen's USB touch. Consider"
  echo "removing them (README, \"The screen\")."
fi

# What earlier runs recorded as added by us.
recorded=()
if [[ -f "$record" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    if [[ -z "$line" || "$line" == "#"* ]]; then continue; fi
    recorded+=("$line")
  done <"$record"
fi

out=()
if [[ "$mode" == add ]]; then
  hdmi1="video=HDMI-A-1:800x480M@60"
  if (( force )) || contains "video=HDMI-A-1:800x480M@60D" ${tokens[@]+"${tokens[@]}"}; then hdmi1="${hdmi1}D"; fi
  ours=("$hdmi1" "video=HDMI-A-2:800x480M@60" "consoleblank=0")
  for t in ${tokens[@]+"${tokens[@]}"}; do
    case "$t" in
      video=HDMI-A-1:* | video=HDMI-A-2:* | consoleblank=*) continue ;;
    esac
    out+=("$t")
  done
  out+=("${ours[@]}")
  # Added by us: what an earlier run recorded and we still set, plus what wasn't there before this run.
  added=()
  for t in "${ours[@]}"; do
    if contains "$t" ${recorded[@]+"${recorded[@]}"} || ! contains "$t" ${tokens[@]+"${tokens[@]}"}; then added+=("$t"); fi
  done
else
  added=()
  for t in ${tokens[@]+"${tokens[@]}"}; do
    if contains "$t" ${recorded[@]+"${recorded[@]}"}; then continue; fi
    out+=("$t")
  done
fi

new_cmdline="${out[*]+"${out[*]}"}"$'\n'
# Same arguments in the same order: leave the file exactly as it is.
[[ "${out[*]+"${out[*]}"}" == "${tokens[*]+"${tokens[*]}"}" ]] && new_cmdline="$cmdline_text"
replace_if_changed "$cmdline" "$new_cmdline"

if (( ${#added[@]} > 0 )); then
  record_text="# Kernel arguments scripts/screen-display.sh added to cmdline.txt; --remove takes out only these."$'\n'
  for t in "${added[@]}"; do record_text+="$t"$'\n'; done
  if [[ ! -f "$record" || "$(cat "$record"; printf x)" != "${record_text}x" ]]; then
    printf '%s' "$record_text" >"$record"
    sync
  fi
elif [[ -f "$record" ]]; then
  rm -f "$record"
  sync
fi

if [[ $changed == 0 ]]; then
  echo "Display settings: nothing to change."
else
  echo "Display settings changed: they apply at the next reboot."
fi
