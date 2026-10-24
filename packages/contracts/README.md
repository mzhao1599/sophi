# Shared contracts

Versioned schemas for messages between the web app, cloud API, Pi and ESP32s. Written with [zod](https://zod.dev) 4 in TypeScript; the Pi and firmware will need generated or hand-written equivalents when they start using a contract.

| File | Contract | Version |
| --- | --- | --- |
| `src/catalog.ts` | Module catalog (the seed list of modules, their limits, prerequisites and dependencies) and `checkSelection`, the dependency rules shared by the review screen and the API | catalog v1 |
| `src/onboarding.ts` | Onboarding session API: session view, turn requests (`text`, `answer`, `skip`, `skip_rest`, `revisit`), profile edits, confirmation, device configuration, error envelope | API v1 |
| `src/serial.ts` | Pi ↔ ESP32 JSON Lines envelope (`hello`, `heartbeat`, `hand.input`, `perception.zones`, `haptic.play`, `ack`, `error`), the 1 KiB line limit and `parseSerialLine`. Specified, not implemented on any device | serial v1 |
| `src/device.ts` | Pi ↔ cloud: capability manifest, sensor snapshot with `readZone` (missing or stale reads as unknown), action request and status report with `canFollowActionStatus`. Specified, no route or Pi code yet | device API v1 |

Not yet written: agent tool arguments and the Pi's reply to a serial `hello` (see [interfaces](../../docs/interfaces.md)).

Language-neutral fixtures for the serial envelope live in `test/fixtures/`: `serial-v1.valid.jsonl` (every line must parse) and `serial-v1.invalid.json` (each line with the problem code it must produce). A Python Pi runtime or C++ firmware parser should run the same files.

Rules:

- Wire format is snake_case JSON. Validate on both sides: the API parses requests and the browser client parses responses with these schemas.
- Catalog estimates (cost, weight, power) stay `not_measured` until a bench record exists. Never fill them with a guess.
- Changing a shape means updating [interfaces](../../docs/interfaces.md) in the same change. Adding an optional field is compatible; renaming or removing one needs a new version.
- The serial and device schemas are strict (an undocumented field is rejected), so a new optional field reaches the receiver's schema before any sender emits it.

```bash
pnpm --filter @walker/contracts test
```
