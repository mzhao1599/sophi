import type { NextRequest } from "next/server";
import { PhoneAskForHelpRequestSchema } from "@walker/contracts";
import { circleRoute, circleService, memberCaller } from "@/server/circle";
import { readJson, walkerJson } from "@/server/walker";

/** POST /api/v1/circle/help — her own phone's "Ask for help" (member cookie). `201` new, `200` the open one or a repeat. */
export async function POST(request: NextRequest) {
  return circleRoute("circle.help.ask", null, async () => {
    const body = await readJson(request, PhoneAskForHelpRequestSchema);
    if (body instanceof Response) return body;
    const { created, response } = await circleService().askForHelp(memberCaller(request), body);
    return walkerJson(response, created ? 201 : 200);
  });
}
