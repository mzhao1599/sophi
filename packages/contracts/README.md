# Shared contracts

Versioned schemas for messages between the web app, cloud API, Pi and ESP32s. Written with [zod](https://zod.dev) 4 in TypeScript; the Pi and firmware will need generated or hand-written equivalents when they start using a contract.

| File | Contract | Version |
| --- | --- | --- |
| `src/catalog.ts` | Module catalog (the seed list of modules, their limits, prerequisites and dependencies) and `checkSelection`, the dependency rules shared by the review screen and the API | catalog v1 |
| `src/onboarding.ts` | Onboarding session API: session view, turn requests (`text`, `answer`, `skip`, `skip_rest`, `revisit`), profile edits, confirmation, device configuration, error envelope | API v1 |

Not yet written: the serial envelope, capability manifest, sensor snapshot and action request/status from [interfaces](../../docs/interfaces.md).

Rules:

- Wire format is snake_case JSON. Validate on both sides: the API parses requests and the browser client parses responses with these schemas.
- Catalog estimates (cost, weight, power) stay `not_measured` until a bench record exists. Never fill them with a guess.
- Changing a shape means updating [interfaces](../../docs/interfaces.md) in the same change. Adding an optional field is compatible; renaming or removing one needs a new version.

```bash
pnpm --filter @walker/contracts test
```
