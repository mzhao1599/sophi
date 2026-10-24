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
| `/` | The demo, one page: a guided chat beside a live drawing of the walker, then the clickable walker to adjust, save and order (built) |
| `/onboarding`, `/onboarding/review` | Redirect to `/` (they were the separate conversation and review pages) |
| `/walker` | **Your walker**: pair a walker, watch it live, read and join its conversation, confirm or decline what it offers (see below) |
| `/devices` | Paired devices, online/last-seen state, actual modules |
| `/devices/[id]/settings` | Audio/haptic preferences, privacy, caregivers if later supported |
| `/devices/[id]/activity` | Human-readable action and fault history |

Do not show a module as “installed” merely because it was recommended. Distinguish `recommended`, `selected`, `installed`, `healthy`, and `enabled` in UI and API state.

## Your walker page

`/walker` is the owner's page for the always-on walker assistant ([guide](walker-assistant.md)), separate from the onboarding demo on `/`. It talks only to the owner's routes in [`walker.ts`](../../packages/contracts/src/walker.ts) (`/api/v1/walkers/...`, proven by the `walker_owner` cookie) through one interface, `WalkerPageApi` in `apps/web/src/lib/walkerApi.ts`, so a development fake (`walkerFake.ts`) can stand in for the server. The expected results it is tested against are in `apps/web/test/walker-page.EXPECTED.md`.

- **No walker:** "Connect a walker" asks for a pairing code and shows it large with a countdown and the command to run on the walker (`walker pair <code> --server <this site>`). The page switches to the walker as soon as a poll lists it.
- **Paired:** the walker's name, Online or Offline with "last seen", a Simulator badge when the whole walker is the simulator, and the pen-drawn walker with each reported part lit by what the walker says now: solid green only for a real, healthy part, dashed green and the word "Simulated" for a stand-in, a dotted outline and "Unavailable" when it isn't there. Under it, the alert settings ("Applied" only when the walker reports the current configuration version, "Waiting for the walker" until then) and the obstacle zones (a distance with its age, or "Unknown" with the reason; never "clear").
- **Conversation:** turns and the walker's own lines, oldest first. Each says who heard it ("You said (as heard by Gemini)", "You typed", or "Steady didn't catch that"), notes when the fixed replies answered, and names the voice the server offered (Cartesia's or the walker's own). A typed question goes to `POST …/turns` with a fresh `client_turn_id`; the same words retried after a failure reuse it. The notice about Gemini, Cartesia and the hour's retention is on screen above the box before anyone types.
- **Offers:** the open proposal as a card with the server's summary, what changes, a countdown, and Confirm and Decline. Once closed, the buttons give way to one line saying how (from the server's answer, or, when it closed elsewhere, only what the status proves).
- **Forget this walker**, behind a modal confirm.
- **Live:** polls `GET /api/v1/walkers` every 1.5 s while the tab is visible. After 5 s without an answer it says so, shows "Status unknown" and turns every zone "Unknown", so old readings never sit on screen looking current. Every error code has a plain sentence.
- **Accessibility:** one polite live region reads each new reply, walker line, offer and connection change once (never the history on load, never the countdowns); every control is a real button, input or select with a name; focus follows the person's action when the pressed control goes away; the drawing is hidden from screen readers and described in words; reduced motion stops the pen and the contour field.
- **Checked (2026-10-24):** a headless Chromium script drove `/walker?fake=1` by keyboard alone through pairing, a reply, an offer confirmed and one expiring, offline, the server going down, each error code and Forget (55 of 55 checks), then checked 390 px wide and 720 px (200% zoom of 1440) for sideways scroll and cut-off controls, and reduced motion (no pen, the frame drawn at once). Against the real routes and the Pi simulator, see the [walker demo rehearsal](../demo/walker-script.md#rehearsal-results). Not yet: VoiceOver or NVDA.
- **Development fake:** `/walker?fake=1`, in development only, uses the fake, shows a "Fake walker" banner across the top, and adds a "Fake walker controls" panel to pair, speak a walker line, go offline, press Confirm on the walker, expire the offer, take the server down, and make the next action fail with any error code.

## Data handoff

Use the session/turn API in [interfaces](../interfaces.md). The UI sends a turn with a revision and renders both assistant text and structured recommendation updates. It treats the model's profile patch as a suggestion until the user reviews it. When the user confirms, persist a versioned configuration; the Pi separately reports physical capabilities. Prefer server-rendered authenticated pages for private settings and keep privileged keys server-side.

For an optional “call the onboarding agent” integration, expose the same session/turn flow through a narrow authenticated API and a machine-readable description. A caller starts a session, sends a user-provided message, reads structured recommendations, then asks the user to confirm. It cannot impersonate a user, bypass consent, or auto-confirm modules. This is a planned interface, not a live endpoint today.

## Handoff for the first PR

Create a Next.js app with a simple design system, authenticated/demo session boundary, static module catalog fixture, and accessible text onboarding flow. Add the real agent endpoint after the deterministic UI is usable. Document local setup, environment variables by *name* only, and a short manual accessibility checklist in `apps/web/README.md`.

**Done (demo mode):** the one-page demo at `/` (a conversation with the assistant, the walker drawing itself in, the clickable walker sheet, save, Stripe test-mode order), the module catalog in `packages/contracts`, the deterministic engine and the optional LLM agent in `services/cloud-api`, and passwordless sign-in with Supabase (kept, but not linked from the demo). `/walker` (Your walker) is built, tested against its development fake, and checked on 2026-10-24 against a local server (in-memory store) with the Pi simulator from `devices/pi`: pairing from the page, the page switching to the walker, live parts and zones marked Simulated, the walker's own lines, offline and back, Forget (the walker then asks to be paired again), and the walker-side pairing lockout; typed questions wait for the assistant turn and say "Steady's server can't do that yet." until then. Not done: speech, `/devices` and settings. See [apps/web](../../apps/web/README.md).
