# Sophi

Sophi is an experimental physical augmentation walker for Cal Hacks. A user starts in an accessible web app, describes the tasks they want help with, and receives a small, explainable set of recommended modules. On the walker, physical controls, speech, haptics, cameras, and optional robot arms work through a Raspberry Pi 5. Local software handles time-sensitive sensing and stop behavior; cloud software handles conversation, planning, and user preferences.

**Status:** the web app, **Sophi** ("A physical augmentation walker."), is a one-page demo that works end to end: a conversation with the onboarding assistant beside a pen-drawn walker that draws in what's suggested, then the walker as a sheet to adjust, save and order in Stripe test mode, backed by a deterministic onboarding engine (or, when configured, a model that words the questions) and shared contracts (see [apps/web](apps/web/README.md)). The walker doesn't work end to end yet. The Pi service ([devices/pi](devices/pi/README.md)) runs the walker's demo path in a simulator on a Mac. Since 2026-10-23 it has also run on the real Raspberry Pi 5, paired with the server on Render, with a USB microphone, a USB soundbar and Piper. At least three answered spoken turns are documented on the real Pi: the first ("What can you help me with?", answered by Gemini 3.96 s after Talk was let go and heard through the soundbar in Cartesia's voice), then two more after a cold boot on 2026-10-24. Confirm, the obstacle sensors and the demo's beats in order haven't run on it yet. The ESP32 firmware for the hand controls and obstacle sensors ([firmware](firmware/README.md)) is written and tested on a computer. Both hand boards have said hello to the Pi (2026-10-24), and the Talk-press buzz was felt on 2026-10-23; which button is Talk and which is Confirm still needs a press check, and the obstacle board hasn't run on hardware. Hardware selections and electrical budgets still need bench validation. This is a prototype, not a certified mobility aid or a substitute for a caregiver.

To run the web app: `pnpm install`, then `pnpm dev`, and open <http://localhost:3000>. `pnpm test` and `pnpm typecheck` cover every package.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `pnpm test`, `pnpm typecheck` and `pnpm build` on every pull request to `main` and every push to `main`. The database tests need a local Supabase stack (Docker, `pnpm supabase start`, then `pnpm test:db`); CI skips them. Deploying to Vercel with a hosted Supabase project: [apps/web/README.md](apps/web/README.md#deploy-on-vercel).

## What a user experiences

1. **Onboard:** sign in or use a clearly labeled demo mode; choose text, speech, or both. The onboarding assistant asks about daily tasks, environment, preferences, and access needs without requiring a diagnosis. It recommends only modules with a concrete benefit, shows why, and lets the user edit the recommendation.
2. **Configure:** review a plain-language module list and choose voice, haptic, control, and privacy preferences in the same web app. A device pairing flow transfers those settings to the Pi.
3. **Use the walker:** press a reachable control to speak or use the web app. The assistant can answer questions and propose actions. Obstacle proximity alerts and haptic cues work locally even if the internet fails.
4. **Manipulate objects:** if arms are installed, a separate manipulation workflow can inspect camera views and propose a short task. The Pi verifies the task and requires an explicit user start signal before bounded motion. Physical stop and local limits always take priority.

The intended modules are two SO-101 arms with overhead and gripper cameras on a linear lift; left and right ESP32 hand controls; an ESP32 time-of-flight (ToF) perception module; an ESP32 voice/speaker module; and optional GPS/location sharing. The Pi 5 is the device coordinator. Modules are optional: a user should not need to buy or carry hardware that does not help them.

## Start here

| Reader | Document |
| --- | --- |
| Everyone | [Architecture](docs/architecture.md), [project scope and decisions](docs/project-plan.md) |
| Future coding agents | [AGENTS.md](AGENTS.md), then the relevant subsystem guide |
| Web and onboarding developers | [Web app](docs/subsystems/web-and-onboarding.md) |
| Cloud/AI developers | [Agent design](docs/subsystems/cloud-agents.md), [walker assistant (always on)](docs/subsystems/walker-assistant.md), [interfaces](docs/interfaces.md) |
| Agent implementers | [Detailed runtime blueprint](docs/agent-runtime.md) |
| Pi developers | [Pi runtime](docs/subsystems/pi-runtime.md), [walker assistant (always on)](docs/subsystems/walker-assistant.md), [interfaces](docs/interfaces.md) |
| ESP32 developers | [ESP32 firmware](docs/subsystems/esp32-firmware.md), [interfaces](docs/interfaces.md) |
| Robot developers | [Arms and lift](docs/subsystems/manipulation.md) |
| Electrical/mechanical developers | [Current hardware inventory](hardware/current-build.md), [hardware and power](docs/subsystems/hardware-and-power.md) |

## Proposed repository layout

```text
apps/web/                 Next.js onboarding, settings, device pairing
services/cloud-api/       Agent orchestration and authenticated device API
devices/pi/               Raspberry Pi runtime and module adapters
firmware/                 ESP32 firmware (PlatformIO): hand controls and haptics, ToF obstacle sensing
firmware/voice/           Microphone, speaker, and button interface if used (planned)
hardware/                 Schematics, CAD, BOM, wiring and test records
packages/contracts/       Versioned event and command schemas
supabase/                 Postgres migrations (tables, RLS), local stack config, sign-in email template
scripts/                  Supabase CLI at a pinned version, database test runner
docs/                     Architecture, interfaces, subsystem guides
```

These directories are ownership boundaries, not a commitment to a package manager or framework configuration. Add build tooling when implementing the first component; keep the documented contracts shared across languages.

## Core principles

- **User choice:** ask about tasks and preferences; do not infer a required module from a disability label.
- **Local safety:** the cloud may request a task but may never directly drive motors, suppress a stop, or disable a proximity alert.
- **Graceful disconnection:** controls, stops, and basic proximity cues remain useful without cloud access.
- **Accessible by design:** target [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) for the web experience; test with keyboard, screen reader, zoom, captions/transcripts, and real users when possible.
- **Explainability:** show what the assistant knows, which modules are present, what an action will do, and how to cancel it.
- **Privacy:** collect only what is needed; treat disability, voice, images, and location as sensitive data.

## Current decisions and open questions

The proposed software baseline is TypeScript/Next.js for the web app, a cloud API deployed on Vercel, Supabase Auth/Postgres/Storage for accounts and durable state, a Pi service with typed adapters, and ESP32 firmware over USB serial. See [project scope and decisions](docs/project-plan.md) for which choices are provisional, how to stage the hackathon demo, and what must be measured before hardware integration.

## Sponsor technologies

What each sponsor's technology does in Sophi, and whether it runs today. How the demo frames each sponsor track is in [docs/demo/tracks.md](docs/demo/tracks.md).

| Technology | Where | Status |
| --- | --- | --- |
| Google Gemini API (`gemini-3.7-flash`) | The onboarding agent reads the person's words and words each question ([gemini.ts](services/cloud-api/src/onboarding/gemini.ts)); the walker assistant hears a spoken question and answers it in one call, with `gemini-3.6-flash` asked alongside as a backup when 3.7 is slow ([walker assistant](services/cloud-api/README.md#walker-assistant)) | Onboarding: runs on the demo laptop. Walker: built and checked live with the demo's lines; at least three answered spoken turns documented on the real Pi (the first on 2026-10-23, before the backup model, and two more on 2026-10-24) |
| Anthropic Claude (`claude-opus-5-5`) | The same onboarding agent, behind the same adapter ([anthropic.ts](services/cloud-api/src/onboarding/anthropic.ts)); typed questions to the walker assistant, with spoken ones staying on Gemini ([walker assistant](services/cloud-api/README.md#walker-assistant)) | Onboarding: rehearsed live on the laptop 2026-10-24, 9 of 9 paths on 3 runs. Typed walker turns: see [the Anthropic section](docs/demo/tracks.md#anthropic-only-with-a-claude-key) |
| Cartesia text-to-speech (`sonic-3.6`) | The walker assistant's spoken replies, made on the server from the reply's text ([speech.ts](services/cloud-api/src/walker/speech.ts)); the walker's own voice covers offline lines and any failure. Setup, features and limits: [Sophi and Cartesia](docs/demo/tracks.md#sophi-and-cartesia-the-readme-section-for-cartesias-judges) | Built; heard live through the deployed server on 2026-10-23, and through the real Pi's soundbar for its first documented spoken turn that night |
| Stripe Checkout (test mode only) | "Order (Demo)" for a saved walker, at placeholder prices | Runs today |

## Contributing

Read [AGENTS.md](AGENTS.md) before making changes. Each component should have a short README explaining what it owns, how to run it, its dependencies, and how it exchanges data with the Pi or cloud. Keep this root README product focused; put wire formats in [interfaces](docs/interfaces.md) and implementation detail in subsystem guides. Never commit credentials, private recordings, or real user health/location data.
