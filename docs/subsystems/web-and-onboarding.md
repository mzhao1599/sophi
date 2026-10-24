# Web app and onboarding guide

**For:** the web developer, designer, and onboarding agent developer. The proposed home is `apps/web/`; the agent implementation may live in `services/cloud-api/` or server-only Next.js code.

## What to build

The web app has four primary areas: (1) onboarding chat, (2) review and edit a module recommendation, (3) pair and view a walker, and (4) change preferences and privacy settings. It should feel polished through good type, clear hierarchy, responsive layout, and useful feedback. Accessibility is part of the experience, not an optional theme.

### Onboarding sequence

1. Explain what the prototype does and ask for data/microphone consent separately. Offer a text-first path and a demo mode that avoids saving sensitive details.
2. Ask one focused question at a time about a task, environment, and preferred feedback. Examples: “What would you like help doing while using the walker?” and “Would a spoken cue or a vibration be easier to notice?” Do not require a medical diagnosis or force a user to disclose one.
3. Show an editable running summary labeled “What I understood.” Distinguish facts the user said from assistant inferences. Let users correct or remove entries.
4. Recommend only catalog modules that match a stated need. Show a reason, prerequisites, limits, and why a lighter alternative might suffice. Let the user add/remove modules manually.
5. Confirm the configuration and explain that hardware availability and bench checks determine what can be enabled on the actual device.

The onboarding agent does not silently change a confirmed configuration. A later change shows a diff and requires confirmation. If information is insufficient, ask a concise follow-up or say that the recommendation is uncertain. Avoid overclaiming what ToF, GPS, or manipulation can do.

## Accessibility requirements

Target [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/). Implement semantic headings, landmarks, real buttons/labels, keyboard operability, visible focus, logical tab order, readable contrast, scalable text, no information conveyed by color alone, and sufficient target size/spacing. Every voice interaction has a text equivalent; every important sound has visible text, and useful haptic/visual alternatives should be considered on device. Streaming chat updates should announce meaningfully through a controlled live region without reading partial tokens constantly. Keep motion subtle and honor reduced-motion preferences. Do not auto-start microphone capture.

Test with keyboard only, browser zoom, at least one screen reader, a mobile viewport, and a user or teammate who does not know the flow. An automated accessibility check is useful but cannot replace those checks. The UI should make slow agent responses, retries, errors, and offline/device-unavailable states understandable.

## Suggested page map

| Route | Purpose |
| --- | --- |
| `/` | Clear project introduction, demo entry, and sign-in |
| `/onboarding` | Conversation, progress, transcript, editable summary |
| `/onboarding/review` | Module cards with rationale and manual selection |
| `/devices` | Paired devices, online/last-seen state, actual modules |
| `/devices/[id]/settings` | Audio/haptic preferences, privacy, caregivers if later supported |
| `/devices/[id]/activity` | Human-readable action and fault history |

Do not show a module as “installed” merely because it was recommended. Distinguish `recommended`, `selected`, `installed`, `healthy`, and `enabled` in UI and API state.

## Data handoff

Use the session/turn API in [interfaces](../interfaces.md). The UI sends a turn with a revision and renders both assistant text and structured recommendation updates. It treats the model's profile patch as a suggestion until the user reviews it. When the user confirms, persist a versioned configuration; the Pi separately reports physical capabilities. Prefer server-rendered authenticated pages for private settings and keep privileged keys server-side.

For an optional “call the onboarding agent” integration, expose the same session/turn flow through a narrow authenticated API and a machine-readable description. A caller starts a session, sends a user-provided message, reads structured recommendations, then asks the user to confirm. It cannot impersonate a user, bypass consent, or auto-confirm modules. This is a planned interface, not a live endpoint today.

## Handoff for the first PR

Create a Next.js app with a simple design system, authenticated/demo session boundary, static module catalog fixture, and accessible text onboarding flow. Add the real agent endpoint after the deterministic UI is usable. Document local setup, environment variables by *name* only, and a short manual accessibility checklist in `apps/web/README.md`.
