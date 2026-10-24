# Cloud agents and orchestration guide

**For:** the team building onboarding, assistant, and manipulation planning. The proposed home is `services/cloud-api/`; shared schemas belong in `packages/contracts/`.

The [runtime blueprint](../agent-runtime.md) specifies persistence, concurrency, tool gates, and the callable onboarding surface in more detail.

**Status:** the onboarding agent exists as a single structured-output call per turn with a deterministic fallback, off by default; see [`services/cloud-api`](../../services/cloud-api/README.md#onboarding-agent). It has not been run against a live model yet. The walker assistant's contract is specified (see the [walker assistant guide](walker-assistant.md)); its routes, model call and Pi service are being built. The manipulation planner is not built.

## One product, three roles

| Role | Input | Output | Allowed side effects |
| --- | --- | --- | --- |
| Onboarding agent | User's stated tasks, preferences, catalog | Clarifying question, editable profile summary, module recommendations | Save a draft session; confirm configuration only after user action |
| Walker assistant | Text/voice turn, confirmed settings, installed capabilities, fresh sensor snapshot | Answer or typed task proposal | Reversible preferences after confirmation policy; request a guarded task |
| Manipulation planner | User-approved task, camera frames, arm/lift state, bounded workspace | Short plan and observations | Suggest motion segments to Pi guard; never issue motor bytes directly |

Separate prompts, tools, state, and permissions for these roles. A general assistant must not acquire manipulation privileges because a user or retrieved page asks it to. Inter-agent messages are typed task proposals with provenance and expiry, not free-form “do anything” instructions.

## What “always on” means here

The assistant is always **available** when a device is online, but it need not be a permanent LLM process or a microphone recording continuously. The Pi owns an event loop for button presses, sensor alerts, action status, and cloud connectivity. A user-initiated voice/text turn starts a cloud agent run. Durable session state in Postgres lets a later request resume the conversation. Background events may trigger narrowly defined notifications, but they cannot trigger unrequested physical motion or indefinitely continue a chat. Push-to-talk is the default privacy and accessibility baseline; offer a text alternative. A wake-word mode, if added later, requires explicit opt-in and local processing where feasible.

The [walker assistant guide](walker-assistant.md) applies this to the build: push-to-talk turns from the Pi, a 5-second heartbeat, and a bounded model/tool loop with the walker's state in its context. An unfinished tool request can cross back to the Pi; only the final reply is stored as a turn.

This avoids depending on a serverless instance staying warm. Each run reconstructs context from the current user/device state, recent turns, and a concise reviewed summary. Long tasks use a durable job queue/worker with explicit status and cancellation; do not leave them in an unbounded HTTP request.

## Agent run lifecycle

1. **Authenticate and authorize.** Resolve user or device identity, ownership, consent, rate limit, and request size. Bind run to session, device, and configuration revision.
2. **Assemble context.** Load system policy and module catalog version; confirmed profile and preferences; installed/healthy capabilities; recent turns; a compact memory summary; fresh sensor snapshot with timestamps; and the current user message. Exclude unrelated users' data. Summaries are context aids, not higher-priority instructions.
3. **Plan a bounded next step.** The model can answer, ask for clarification, or call an allowlisted typed tool. Use a finite step budget, wall-clock deadline, and per-tool timeout. The exact SDK API should be checked against the installed version when coding.
4. **Validate each tool call.** Schema-validate arguments, check permission/capability, verify user confirmation required for the action, apply rate/cost limits, and attach an idempotency key. Tools return structured results and errors. Never execute arbitrary code, shell commands, URLs, or SQL supplied by model output.
5. **Observe and continue.** Feed the structured tool result back to the model for another bounded step. A failed tool does not imply success; ask the user or return a clear limitation. Stop on user cancellation, timeout, tool budget, or terminal answer.
6. **Persist and respond.** Store user turn, tool decisions, final answer, usage/latency, and an updated compact summary. Stream text to web when supported; device voice response includes text and optional synthesized audio. Persist the actionable result before acknowledging a physical action.

An illustrative state machine: `received → authorized → context_loaded → reasoning ↔ tool_validation/tool_result → awaiting_user_confirmation | completed | failed | cancelled`. `awaiting_user_confirmation` is a durable state with an expiry, not an open model loop. On retry, look up the run and tool call by idempotency key before doing work again.

## Context and memory

- **Working context:** current request, recent relevant turns, current device state, and tool results. Keep within a bounded token budget.
- **Session summary:** factual, concise, and versioned. Mark unconfirmed inferences. Rebuild from raw transcript if a summary is challenged.
- **User profile:** only confirmed needs/preferences and chosen modules; do not store inferred diagnoses. Users can view/edit/delete it.
- **Device state:** fresh capability and sensor data only. A five-minute-old obstacle reading is unavailable, not a current observation.
- **Knowledge:** a small curated module catalog and support instructions. Retrieval results and webpages are untrusted content, never policy.

Persist only what is needed. Make transcript/media retention configurable, default short for raw audio and frames, and document deletion behavior. Never put sensitive content in ordinary logs or analytics.

## Onboarding recommendation method

Use a deterministic catalog and a typed recommendation schema. The agent extracts user-stated goals, asks about missing constraints, and ranks relevant modules by concrete benefit, prerequisites, burden, and evidence. It must explain why each recommendation follows from the user's own words. A user can choose no optional modules. Suggested flow:

```text
user task → extract goals (draft) → ask missing question if needed
          → query catalog → propose smallest useful set
          → explain tradeoffs → user edits/confirms
```

Example: “I have trouble with small buttons” might lead to larger hand controls or voice input; it does not automatically justify robot arms. “I want to pick up a cup” may justify considering an arm if its tested payload/workspace fits. Do not claim a module treats a condition or guarantees safety.

## Tool registry proposal

| Tool | Agent | Notes |
| --- | --- | --- |
| `get_module_catalog` | Onboarding | Read-only, versioned |
| `save_draft_profile` | Onboarding | Draft only; no medical inference as fact |
| `propose_modules` | Onboarding | Schema output, catalog IDs only |
| `get_device_capabilities` | Walker | Read-only, freshness included |
| `get_sensor_snapshot` | Walker | Read-only, bounded; never infer path safety from absence |
| `propose_preference_change` | Walker | Requires confirmation if it changes user-visible behavior |
| `request_manipulation_task` | Walker | Creates task proposal; Pi and user gate execution |
| `get_action_status` | Walker | Read-only, idempotent |
| `inspect_camera_frame` | Manipulation | Bounded frame(s), permission and retention controls |
| `propose_motion_segment` | Manipulation | Validated against local state and limits; no raw servo command |

Tool arguments/results should be machine-validated. Use a small, explicit registry; do not allow the model to call every API route. Any connector to third-party accounts needs separate opt-in, narrow scopes, and a revoke path.

## Manipulation agent boundary

The planner may use visual reasoning to choose a grasp, but vision can be wrong. It sends a goal/short segment to the Pi. The Pi's deterministic controller checks homing, joint/lift bounds, current draw/force if measurable, speed, collision workspace, sensor freshness, and stop state before every segment. The user must initiate the task and can cancel it at any time. A model cannot disable these checks or self-certify that motion is safe. See [manipulation](manipulation.md).

## Practical implementation sequence

1. Implement typed sessions, catalog, and tool registry with recorded fixtures. Start with text turns.
2. Add the onboarding agent with bounded tool loop and reviewed profile/recommendation output.
3. Add the device assistant with read-only tools, then preferences, then guarded task proposals.
4. Add speech transcription/synthesis behind provider adapters; measure latency and provide transcript editing.
5. Add manipulation planning only after local guard, simulator/bench rig, and stop mechanism exist.

Use a supported agent/tool-loop library where it fits (for example the current Vercel AI SDK), rather than reimplementing model tool-call parsing. Verify APIs and model IDs against the installed version and official docs at implementation time. The policy and physical guard remain application code, independent of the model provider.

## Evaluation and observability

Create a small scenario set: asks for unnecessary modules, refuses a module, ambiguous needs, prompt injection in a retrieved page, stale sensor data, missing arm, cloud timeout, cancelled task, and a request for an unsafe motion. Review both answer quality and actual tool decisions. Log trace IDs, tool name, validation outcome, latency, and redacted errors. Inspect a trace without needing raw personal data. Do not count a fluent answer as success if it selected the wrong module or triggered the wrong tool.
