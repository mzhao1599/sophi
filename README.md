# Assistive Walker

An experimental, modular AI assistive walker for Cal Hacks. A user starts in an accessible web app, describes the tasks they want help with, and receives a small, explainable set of recommended modules. On the walker, physical controls, speech, haptics, cameras, and optional robot arms work through a Raspberry Pi 5. Local software handles time-sensitive sensing and stop behavior; cloud software handles conversation, planning, and user preferences.

**Status:** architecture and developer documentation only. This repository does not yet contain a working walker, firmware, web app, or cloud service. Hardware selections and electrical budgets still need bench validation. This is a prototype, not a certified mobility aid or a substitute for a caregiver.

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
| Cloud/AI developers | [Agent design](docs/subsystems/cloud-agents.md), [interfaces](docs/interfaces.md) |
| Agent implementers | [Detailed runtime blueprint](docs/agent-runtime.md) |
| Pi developers | [Pi runtime](docs/subsystems/pi-runtime.md), [interfaces](docs/interfaces.md) |
| ESP32 developers | [ESP32 firmware](docs/subsystems/esp32-firmware.md), [interfaces](docs/interfaces.md) |
| Robot developers | [Arms and lift](docs/subsystems/manipulation.md) |
| Electrical/mechanical developers | [Hardware and power](docs/subsystems/hardware-and-power.md) |

## Proposed repository layout

```text
apps/web/                 Next.js onboarding, settings, device pairing
services/cloud-api/       Agent orchestration and authenticated device API
devices/pi/               Raspberry Pi runtime and module adapters
firmware/hand-controls/   Left/right ESP32 controls and haptics
firmware/perception/      ToF sensing and local alert output
firmware/voice/           Microphone, speaker, and button interface if used
hardware/                 Schematics, CAD, BOM, wiring and test records
packages/contracts/       Versioned event and command schemas
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

## Contributing

Read [AGENTS.md](AGENTS.md) before making changes. Each component should have a short README explaining what it owns, how to run it, its dependencies, and how it exchanges data with the Pi or cloud. Keep this root README product focused; put wire formats in [interfaces](docs/interfaces.md) and implementation detail in subsystem guides. Never commit credentials, private recordings, or real user health/location data.
