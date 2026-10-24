import { notFound } from "next/navigation";
import { MemorySessionStore, OnboardingService } from "@walker/cloud-api";
import type { SessionView, TurnInput } from "@walker/contracts";
import { PreviewHarness } from "@/components/PreviewHarness";

/**
 * Development-only previews of each onboarding state, built by running the real engine on a scripted
 * set of answers. Used for design review and the taste-skill inspector, which can't carry a session
 * cookie. Returns 404 in production builds.
 */

const SCRIPT: TurnInput[] = [
  { type: "answer", question_id: "tasks", option_ids: ["obstacles", "reach"], text: "I keep bumping into the door frame in the hallway" },
  { type: "answer", question_id: "places", option_ids: ["home", "outdoors"] },
  { type: "answer", question_id: "feedback", option_ids: ["vibration"] },
  { type: "answer", question_id: "start_request", option_ids: ["left"] },
  { type: "answer", question_id: "reach_detail", option_ids: ["high"] },
  { type: "answer", question_id: "location", option_ids: ["unsure"] },
  { type: "answer", question_id: "anything_else", option_ids: ["nothing"] },
];

async function sessionAfter(steps: number, confirm = false): Promise<SessionView> {
  const service = new OnboardingService(new MemorySessionStore());
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  let view = response.session;
  for (const input of SCRIPT.slice(0, steps)) {
    view = (await service.turn(view.session_id, { token }, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input })).session;
  }
  if (confirm) {
    view = (
      await service.confirm(view.session_id, { token }, {
        last_seen_revision: view.revision,
        selected_module_ids: ["base.walker", "controls.hand", "perception.tof"],
      })
    ).session;
  }
  return view;
}

export default async function Preview({ params }: { params: Promise<{ screen: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { screen } = await params;
  switch (screen) {
    case "start":
      return <PreviewHarness screen="onboarding" session={null} />;
    case "question":
      return <PreviewHarness screen="onboarding" session={await sessionAfter(2)} />;
    case "done":
      return <PreviewHarness screen="onboarding" session={await sessionAfter(SCRIPT.length)} />;
    case "review":
      return <PreviewHarness screen="review" session={await sessionAfter(SCRIPT.length)} />;
    case "saved":
      return <PreviewHarness screen="review" session={await sessionAfter(SCRIPT.length, true)} />;
    default:
      notFound();
  }
}
