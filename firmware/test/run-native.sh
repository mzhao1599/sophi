#!/bin/sh
# Builds and runs the firmware's native checks with the computer's own C++ compiler (no PlatformIO, no
# ESP32 toolchain):
#   1. the unit tests in test/test_protocol and test/test_module, with the address and undefined-behaviour
#      sanitizers, so a read outside a buffer fails the run;
#   2. the provisioning guards: a build with a bad WALKER_MODULE_ID or zone name must fail, and a good one
#      must compile;
#   3. the scripted session: test/session/transcript.txt must match what the code prints now. The vitest
#      cross-check (packages/contracts/test/firmware-session.test.ts) reads that file.
#
# Usage, from anywhere:
#   firmware/test/run-native.sh            run everything
#   firmware/test/run-native.sh --update   rewrite test/session/transcript.txt, then run everything
set -eu
cd "$(dirname "$0")/.."

CXX="${CXX:-c++}"
BUILD=".pio/native-local"
mkdir -p "$BUILD"
FLAGS="-std=c++17 -Wall -Wextra -Werror -Ilib/protocol -Ilib/module"
SANITIZE="-g -fsanitize=address,undefined -fno-sanitize-recover=all"
SOURCES="lib/protocol/serial_protocol.cpp lib/module/module_core.cpp lib/module/haptic.cpp lib/module/debounce.cpp lib/module/zones.cpp"

# 1. Unit tests.
for suite in test_protocol test_module; do
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
echo "all native checks passed"
