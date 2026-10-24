#!/bin/sh
# Builds and runs the firmware's native checks with the computer's own C++ compiler (no PlatformIO, no
# ESP32 toolchain):
#   1. the unit tests in test/test_protocol, test/test_module and test/test_lift, with the address and undefined-behaviour
#      sanitizers, so a read outside a buffer fails the run;
#   2. the provisioning guards: a build with a bad WALKER_MODULE_ID, zone name or lift setting must fail, and
#      a good one must compile;
#   3. the scripted sessions: test/session/transcript.txt and lift_transcript.txt must match what the code
#      prints now. The vitest cross-checks (packages/contracts/test/firmware-session.test.ts and
#      lift-firmware-session.test.ts) read those files.
#
# Usage, from anywhere:
#   firmware/test/run-native.sh            run everything
#   firmware/test/run-native.sh --update   rewrite both transcripts, then run everything
set -eu
cd "$(dirname "$0")/.."

CXX="${CXX:-c++}"
BUILD=".pio/native-local"
mkdir -p "$BUILD"
FLAGS="-std=c++17 -Wall -Wextra -Werror -Ilib/protocol -Ilib/module -Ilib/lift"
SANITIZE="-g -fsanitize=address,undefined -fno-sanitize-recover=all"
SOURCES="lib/protocol/serial_protocol.cpp lib/protocol/lift_protocol.cpp lib/module/module_core.cpp lib/module/haptic.cpp lib/module/debounce.cpp lib/module/zones.cpp lib/lift/lift_core.cpp"

# 1. Unit tests.
for suite in test_protocol test_module test_lift; do
  echo "== $suite"
  # shellcheck disable=SC2086
  $CXX $FLAGS $SANITIZE $SOURCES "test/$suite/test_main.cpp" -o "$BUILD/$suite"
  "$BUILD/$suite"
done

# 2. Provisioning guards (EXPECTED.md P1, Z6).
echo "== provisioning"
must_fail() {
  what=$1
  shift
  if $CXX -std=c++17 -fsyntax-only -Ilib/protocol -Ilib/module "$@" test/provision/check.cpp 2>"$BUILD/provision.log"; then
    echo "FAIL: compiled with $what"
    exit 1
  fi
  if ! grep -q "WALKER_" "$BUILD/provision.log"; then
    echo "FAIL: $what stopped the build for another reason:"
    cat "$BUILD/provision.log"
    exit 1
  fi
  echo "refused: $what"
}
must_build() {
  if ! $CXX -std=c++17 -fsyntax-only -Ilib/protocol -Ilib/module "$@" test/provision/check.cpp; then
    echo "FAIL: did not compile with $*"
    exit 1
  fi
  echo "built: $*"
}
must_fail "no WALKER_MODULE_ID"
must_fail "an empty id" '-DWALKER_MODULE_ID=""'
must_fail "the id any" '-DWALKER_MODULE_ID="any"'
must_fail "an uppercase id" '-DWALKER_MODULE_ID="Hand-left-01"'
must_fail "an id starting with a dash" '-DWALKER_MODULE_ID="-hand"'
must_fail "a 33-character id" '-DWALKER_MODULE_ID="hand-left-01234567890123456789012"'
must_fail "an uppercase zone name" '-DWALKER_MODULE_ID="tof-front-01"' '-DWALKER_ZONE_2="Left"'
must_fail "a repeated zone name" '-DWALKER_MODULE_ID="tof-front-01"' '-DWALKER_ZONE_3="front_left"'
must_fail "a 25-character zone name" '-DWALKER_MODULE_ID="tof-front-01"' '-DWALKER_ZONE_0="abcdefghijklmnopqrstuvwxy"'
must_build '-DWALKER_MODULE_ID="hand-left-01"'
must_build '-DWALKER_MODULE_ID="hand-right-01"'
must_build '-DWALKER_MODULE_ID="tof-front-01"' '-DWALKER_ZONE_2="left_low"'

# The lift's build settings (EXPECTED.md LB2, LB3).
lift_must_fail() {
  what=$1
  shift
  if $CXX -std=c++17 -fsyntax-only -Ilib/protocol -Ilib/module -Ilib/lift "$@" test/provision/lift_check.cpp 2>"$BUILD/provision.log"; then
    echo "FAIL: the lift compiled with $what"
    exit 1
  fi
  if ! grep -q "WALKER_" "$BUILD/provision.log"; then
    echo "FAIL: $what stopped the lift build for another reason:"
    cat "$BUILD/provision.log"
    exit 1
  fi
  echo "refused: lift with $what"
}
lift_must_build() {
  if ! $CXX -std=c++17 -fsyntax-only -Ilib/protocol -Ilib/module -Ilib/lift "$@" test/provision/lift_check.cpp; then
    echo "FAIL: the lift did not compile with $*"
    exit 1
  fi
  echo "built: lift with $*"
}
lift_must_fail "a hand id" '-DWALKER_MODULE_ID="hand-left-01"'
lift_must_fail "the id any" '-DWALKER_MODULE_ID="any"'
lift_must_fail "the id lift-" '-DWALKER_MODULE_ID="lift-"'
lift_must_fail "3 microsteps" '-DWALKER_MODULE_ID="lift-01"' -DWALKER_LIFT_MICROSTEPS=3
lift_must_fail "an enable level of 2" '-DWALKER_MODULE_ID="lift-01"' -DWALKER_LIFT_ENA_ENABLE_LEVEL=2
lift_must_fail "enable level 1 without the inverter" '-DWALKER_MODULE_ID="lift-01"' -DWALKER_LIFT_ENA_ENABLE_LEVEL=1
lift_must_fail "a disable-safe setting of 2" '-DWALKER_MODULE_ID="lift-01"' -DWALKER_LIFT_DISABLE_SAFE=2
lift_must_build '-DWALKER_MODULE_ID="lift-01"'
lift_must_build '-DWALKER_MODULE_ID="lift-01"' -DWALKER_LIFT_MICROSTEPS=16 -DWALKER_LIFT_ENA_ENABLE_LEVEL=1 -DWALKER_LIFT_HW_INVERTER=1
lift_must_build '-DWALKER_MODULE_ID="lift-01"' -DWALKER_LIFT_DISABLE_SAFE=1 -DWALKER_LIFT_STOP_SENSE=0

# 3. The scripted session.
echo "== session transcript"
# shellcheck disable=SC2086
$CXX $FLAGS $SANITIZE $SOURCES test/session/session_main.cpp -o "$BUILD/session"
"$BUILD/session" >"$BUILD/transcript.txt"
if [ "${1:-}" = "--update" ]; then
  cp "$BUILD/transcript.txt" test/session/transcript.txt
  echo "rewrote test/session/transcript.txt"
elif ! diff -u test/session/transcript.txt "$BUILD/transcript.txt"; then
  echo "FAIL: test/session/transcript.txt is out of date. Run firmware/test/run-native.sh --update and commit it."
  exit 1
fi
echo "transcript matches ($(grep -c '^<' test/session/transcript.txt) module lines, $(grep -c '^>' test/session/transcript.txt) Pi lines)"

echo "== lift session transcript"
# shellcheck disable=SC2086
$CXX $FLAGS $SANITIZE $SOURCES test/session/lift_session_main.cpp -o "$BUILD/lift_session"
"$BUILD/lift_session" >"$BUILD/lift_transcript.txt"
if [ "${1:-}" = "--update" ]; then
  cp "$BUILD/lift_transcript.txt" test/session/lift_transcript.txt
  echo "rewrote test/session/lift_transcript.txt"
elif ! diff -u test/session/lift_transcript.txt "$BUILD/lift_transcript.txt"; then
  echo "FAIL: test/session/lift_transcript.txt is out of date. Run firmware/test/run-native.sh --update and commit it."
  exit 1
fi
echo "lift transcript matches ($(grep -c '^<' test/session/lift_transcript.txt) lift lines, $(grep -c '^>' test/session/lift_transcript.txt) Pi lines)"
echo "all native checks passed"
