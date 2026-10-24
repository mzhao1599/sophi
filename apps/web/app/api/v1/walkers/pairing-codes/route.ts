import type { NextRequest } from "next/server";
import { fromThisSite, ownerCaller, setOwnerCookie, walkerError, walkerJson, walkerRoute, walkerService } from "@/server/walker";

/** POST /api/v1/walkers/pairing-codes — a one-time code for the Pi; sets the `walker_owner` cookie if the browser has none. */
export async function POST(request: NextRequest) {
  return walkerRoute("walkers.pairing_code", null, async () => {
    if (!fromThisSite(request)) return walkerError("invalid_request", "Ask for a pairing code from the Your walker page.");
    const caller = ownerCaller(request);
    const { secret, response } = await walkerService().createPairingCode(caller);
    const reply = walkerJson(response, 201);
    if (secret !== caller.secret) setOwnerCookie(reply, secret);
    return reply;
  });
}
