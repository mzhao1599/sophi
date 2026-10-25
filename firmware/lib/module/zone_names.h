// The obstacle board's four zone slots, assigned to physical mux channels in each firmware image.
// Change one with a build flag, for example: build_src_flags = -D WALKER_ZONE_2=\"left_low\"
#pragma once

#include <cstddef>

#include "serial_protocol.h"

#ifndef WALKER_ZONE_0
#define WALKER_ZONE_0 "front_left"
#endif
#ifndef WALKER_ZONE_1
#define WALKER_ZONE_1 "front_right"
#endif
#ifndef WALKER_ZONE_2
#define WALKER_ZONE_2 "left"
#endif
#ifndef WALKER_ZONE_3
#define WALKER_ZONE_3 "right"
#endif

namespace walker {

constexpr size_t kZoneCount = 4;
constexpr const char* kZoneNames[kZoneCount] = {WALKER_ZONE_0, WALKER_ZONE_1, WALKER_ZONE_2, WALKER_ZONE_3};

constexpr bool zoneNamesValid(const char* const* names, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    if (!isSnakeName(names[i], kMaxZoneNameLength)) return false;
    for (size_t j = 0; j < i; ++j) {
      if (sameText(names[i], names[j])) return false;
    }
  }
  return true;
}

static_assert(zoneNamesValid(kZoneNames, kZoneCount),
              "WALKER_ZONE_0..3 must be distinct snake_case names of at most 24 characters");

}  // namespace walker
