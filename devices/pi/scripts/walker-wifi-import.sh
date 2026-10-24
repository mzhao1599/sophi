#!/usr/bin/env bash
# Adds the Wi-Fi networks listed in the SD card's wifi.txt (the boot partition, which any computer can
# edit) to NetworkManager, then replaces each password in the file with "(saved)" so it doesn't stay
# on the card. Runs at boot from walker-wifi.service. Usage: walker-wifi-import.sh [path to wifi.txt]
set -euo pipefail

file="${1:-/boot/firmware/wifi.txt}"
[[ -f "$file" ]] || exit 0

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; printf '%s' "${s%"${s##*[![:space:]]}"}"; }

add_network() {
  local name="$1" password="$2" id="walker: $1"
  # Replace an older entry of the same name. (Not looked up with `nmcli -t`, which writes the ":" in
  # "walker: ..." as "\:", so an exact match would never find it.)
  nmcli connection delete id "$id" >/dev/null 2>&1 || true
  # ipv4.may-fail and ipv6 auto: a network that offers only one kind of address still counts as up.
  if [[ -z "$password" ]]; then
    nmcli connection add type wifi ifname wlan0 con-name "$id" ssid "$name" \
      connection.autoconnect yes ipv4.may-fail yes ipv6.method auto ipv6.may-fail yes >/dev/null
  else
    nmcli connection add type wifi ifname wlan0 con-name "$id" ssid "$name" \
      wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$password" \
      connection.autoconnect yes ipv4.may-fail yes ipv6.method auto ipv6.may-fail yes >/dev/null
  fi
  echo "Added Wi-Fi network: $name"
}

name=""
changed=0
out="$(mktemp)"
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    name:*) name="$(trim "${line#name:}")" ;;
    password:*)
      password="$(trim "${line#password:}")"
      if [[ -n "$name" && "$password" != "(saved)" ]]; then
        add_network "$name" "$password"
        line="password: (saved)"
        changed=1
      fi
      name=""
      ;;
  esac
  printf '%s\n' "$line" >>"$out"
done <"$file"

if (( changed )); then
  cat "$out" >"$file"
  sync
fi
rm -f "$out"
