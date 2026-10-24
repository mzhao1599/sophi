import type { NextRequest } from "next/server";
import { PhoneSendMessageRequestSchema } from "@walker/contracts";
import { circleRoute, circleService, memberCaller } from "@/server/circle";
import { readJson, walkerJson } from "@/server/walker";

/** POST /api/v1/circle/messages — a caretaker's typed message to her phone, or her phone's preset reply (member cookie). */
export async function POST(request: NextRequest) {
  return circleRoute("circle.message", null, async () => {
    const body = await readJson(request, PhoneSendMessageRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await circleService().sendMessage(memberCaller(request), body), 201);
  });
}
