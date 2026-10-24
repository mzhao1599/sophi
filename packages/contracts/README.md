# Shared contracts

Versioned schemas for messages between the web app, cloud API, Pi and ESP32s. Written with [zod](https://zod.dev) 4 in TypeScript; the Pi and firmware will need generated or hand-written equivalents when they start using a contract.

| File | Contract | Version |
| --- | --- | --- |
| `src/catalog.ts` | Module catalog (the seed list of modules, their limits, prerequisites and dependencies) and `checkSelection`, the dependency rules shared by the review screen and the API | catalog v1 |
| `src/onboarding.ts` | Onboarding session API: session view, turn requests (`text`, `answer`, `skip`, `skip_rest`, `revisit`), profile edits, confirmation, device configuration, error envelope | API v1 |
| `src/serial.ts` | Pi ↔ ESP32 JSON Lines envelope (`hello`, `heartbeat`, `hand.input`, `perception.zones`, `haptic.play`, `ack`, `error`), the 1 KiB line limit and `parseSerialLine`. Specified, not implemented on any device | serial v1 |
| `src/device.ts` | Pi ↔ cloud: capability manifest, sensor snapshot with `readZone` (missing or stale reads as unknown), action request and status report with `canFollowActionStatus`. Specified, no route or Pi code yet | device API v1 |
| `src/circle.ts` | Sophi Circle: members, invites, `ScreenSettings` (versioned, apart from `WalkerConfiguration`), `VOICE_CHOICES`, suggestions and joins, messages, the circle feed, the device, owner and member routes, errors, and the walker screen's local `ScreenState`. Proposed, no route or Pi code yet ([interfaces](../../docs/interfaces.md#sophi-circle-and-the-walker-screen-proposed-not-built)) | circle v1 |
| `src/motion.ts` | Arms and lift: joints, calibration files, named poses, lift configuration, skill files with `checkSkillAgainstSetup`, the one pending Confirm target that every non-stop command needs (`ConfirmTargetSchema`, `confirmPressVerdict`, `commandMatchesTarget`), the cloud's id-only `MotionOfferRequestSchema`, the lift's installation record (guards, drop test), the nine motion commands and their rule-8 policy (`MOTION_COMMAND_POLICY`), motion state, latched faults with fixed sentences, and every placeholder limit. **Proposed, not built** | motion v1 |
| `src/lift-serial.ts` | Pi ↔ lift ESP32 lines (`lift.hello`, `lift.status`, `lift.ack`, `lift.done`, `lift.heartbeat`, `lift.home`, `lift.move`, `lift.stop`, `lift.enable`, `lift.clear`) and `parseLiftSerialLine`. **Proposed.** The lift firmware implements it (tested on a computer, cross-checked by `test/lift-firmware-session.test.ts`, not run on hardware); no Pi code | serial v1, `lift.` types |

`test/unchanged-shapes.test.ts` pins the JSON Schema of every schema in `walker.ts` and `device.ts` to `test/fixtures/walker-device-v1.shapes.json`, because today's deployed Pi parses them strictly. Change that snapshot only with the Pi re-bundled first. It doesn't cover refinements and transforms (`.refine`, `.trim()`) or exports that aren't schemas (constants and functions); the walker and device tests cover those.

Not yet written: agent tool arguments and the Pi's reply to a serial `hello` (see [interfaces](../../docs/interfaces.md)).

Language-neutral fixtures for the serial envelope live in `test/fixtures/`: `serial-v1.valid.jsonl` (every line must parse) and `serial-v1.invalid.json` (each line with the problem code it must produce), and the same pair for the lift (`lift-serial-v1.*`). `existing-v1.shapes.json` pins the JSON Schema of catalog, device, serial and walker, which deployed parsers read strictly. A Python Pi runtime or C++ firmware parser should run the same files.

Rules:

- Wire format is snake_case JSON. Validate on both sides: the API parses requests and the browser client parses responses with these schemas.
- Catalog estimates (cost, weight, power) stay `not_measured` until a bench record exists. Never fill them with a guess.
- Changing a shape means updating [interfaces](../../docs/interfaces.md) in the same change. Adding an optional field is compatible; renaming or removing one needs a new version.
- The serial and device schemas are strict (an undocumented field is rejected), so a new optional field reaches the receiver's schema before any sender emits it.

```bash
pnpm --filter @walker/contracts test
```
