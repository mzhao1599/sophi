import type { NextRequest } from "next/server";
import { AddPhoneRequestSchema } from "@walker/contracts";
import { circleError, circleRoute, circleService } from "@/server/circle";
import { fromThisSite, ownerCaller, readJson, walkerJson } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/walkers/{id}/circle/invites — "Add a phone": a 6-digit code for her own phone or a caretaker's (owner cookie). */
export async function POST(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return circleRoute("walkers.circle.invite", id, async () => {
    if (!fromThisSite(request)) return circleError("invalid_request", "Add a phone from the Your walker page.");
    const body = await readJson(request, AddPhoneRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await circleService().addPhone(ownerCaller(request), id, body), 201);
  });
}
