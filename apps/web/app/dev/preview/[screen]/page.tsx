import { notFound } from "next/navigation";
import { MemorySessionStore, OnboardingService, openingQuestion } from "@walker/cloud-api";
import { MODULE_CATALOG, getCatalogEntry, type SessionView, type TurnInput } from "@walker/contracts";
import { CheckoutResult } from "@/components/CheckoutResult";
import { PreviewHarness } from "@/components/PreviewHarness";
import { DEMO_PLACEHOLDER_PRICES_USD_CENTS } from "@/server/checkout/order";

/**
 * Development-only previews of each state of the demo page, built by running the real engine on a
 * scripted set of answers. Used for design review and the taste-skill inspector, which can't carry a session
 * cookie. Returns 404 in production builds.
 */

// The demo persona's lines from docs/demo/script.md (Wren is made up), typed as she types them, then
// "Show me my walker". The deterministic engine answers here, so the previews are the same every time.
const SCRIPT: TurnInput[] = [
  { type: "answer", question_id: "tasks", option_ids: [], text: "I keep bumping into things, small buttons are hard, and I'd like help picking things up." },
  { type: "answer", question_id: "places", option_ids: [], text: "Around my apartment, and at the corner shop." },
  { type: "answer", question_id: "feedback", option_ids: [], text: "A buzz in the handles works best." },
  { type: "answer", question_id: "start_request", option_ids: [], text: "A button on my left handle. I'd rather not talk to it." },
  { type: "answer", question_id: "reach_detail", option_ids: [], text: "Mostly things I drop on the floor." },
  { type: "skip_rest" },
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
  const show = (session: SessionView | null) => <PreviewHarness session={session} opening={openingQuestion()} />;
  switch (screen) {
    case "start":
      return show(null);
    case "chat":
      return show(await sessionAfter(4));
    case "walker":
      return show(await sessionAfter(SCRIPT.length));
    case "saved":
      return show(await sessionAfter(SCRIPT.length, true));
    case "order": {
      // The success page's design, with the saved preview's modules at their placeholder prices. A real
      // order is only ever read from Stripe (loadDemoOrder); this route is development only.
      const ids = (await sessionAfter(SCRIPT.length, true)).configuration?.selected_module_ids ?? [];
      const lines = ids.map((id) => ({ module_id: id, name: getCatalogEntry(MODULE_CATALOG, id).name, amount: DEMO_PLACEHOLDER_PRICES_USD_CENTS[id], currency: "usd" }));
      return <CheckoutResult order={{ kind: "paid", lines, total: lines.reduce((t, l) => t + l.amount, 0), currency: "usd", configuration_version: "1" }} />;
    }
    default:
      notFound();
  }
}
