// Build-time checks of a board's provisioning. Include it from the board's main file only.
//
// WALKER_MODULE_ID is the module's provisioned id, set per board when it is built
// (WALKER_MODULE_ID=hand-left-01 pio run -e hand). The build stops here if it is missing, empty,
// "any" (which only ever addresses a hello.request), or not a contract module id.
#pragma once

#include "serial_protocol.h"

#ifndef WALKER_MODULE_ID
#error "WALKER_MODULE_ID is not set: build with WALKER_MODULE_ID=<this board's id> (see firmware/README.md)"
#endif

static_assert(walker::isProvisionableModuleId(WALKER_MODULE_ID),
              "WALKER_MODULE_ID must be this board's id, such as hand-left-01: lowercase letters, digits and "
              "dashes, at most 32 characters, and never \"any\" (see firmware/README.md)");
