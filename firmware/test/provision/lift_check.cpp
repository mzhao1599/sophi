// Compiled by run-native.sh with good and bad lift build settings: the bad ones must stop the build (LB2, LB3).
#include "../../src/lift/build_settings.h"

int main() { return walker::lift::build::kSettings.microsteps == 0; }
