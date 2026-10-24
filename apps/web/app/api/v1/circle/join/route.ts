import type { NextRequest } from "next/server";
import { JoinCircleRequestSchema } from "@walker/contracts";
import { circleError, circleRoute, circleService, memberCaller, setMemberCookie } from "@/server/circle";
import { clientAddress, fromThisSite, readJson, walkerJson } from "@/server/walker";

/**
 * POST /api/v1/circle/join — a phone types the owner's code; sets the `walker_member` cookie. Refuses a
 * request another site made the browser send, so no other page can replace the phone's cookie.
 */
export async function POST(request: NextRequest) {
  return circleRoute("circle.join", null, async () => {
    if (!fromThisSite(request)) return circleError("invalid_request", "Join from the Sophi app.");
    const body = await readJson(request, JoinCircleRequestSchema);
    if (body instanceof Response) return body;
    const { secret, home } = await circleService().join(memberCaller(request), body, clientAddress(request.headers));
    const reply = walkerJson(home, 201);
    setMemberCookie(reply, secret);
    return reply;
  });
}
