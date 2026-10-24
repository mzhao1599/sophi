#!/usr/bin/env bash
# Adds one Wi-Fi network to the walker, asking for its name and password at the prompt (the password
# isn't shown or saved anywhere but NetworkManager). Usage, on the Pi: sudo walker-wifi-add.sh
# A network added here connects automatically and is preferred over saved networks with the default
# priority (0) when both are in range. For a backup that should stay off (the venue Wi-Fi at Cal Hacks,
# where the walker uses Ethernet), run afterwards:
#   nmcli connection modify "walker: <name>" connection.autoconnect no
set -euo pipefail

read -r -p "Wi-Fi name: " name
[[ -n "$name" ]] || { echo "No name given; nothing changed."; exit 1; }
read -r -s -p "Wi-Fi password (empty for an open network): " password
echo
id="walker: $name"
# Replace an older entry of the same name (`nmcli -t` would write its ":" as "\:", so don't match on that).
nmcli connection delete id "$id" >/dev/null 2>&1 || true
args=(type wifi ifname wlan0 con-name "$id" ssid "$name" connection.autoconnect yes
  connection.autoconnect-priority 10 ipv4.may-fail yes ipv6.method auto ipv6.may-fail yes)
[[ -n "$password" ]] && args+=(wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$password")
nmcli connection add "${args[@]}" >/dev/null
echo "Saved \"$name\". The walker will use it whenever it's in range."
