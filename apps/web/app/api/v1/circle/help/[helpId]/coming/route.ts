import type { NextRequest } from "next/server";
import { circleRoute, circleService, memberCaller } from "@/server/circle";
import { walkerJson } from "@/server/walker";

type Context = { params: Promise<{ helpId: string }> };

/** POST /api/v1/circle/help/{helpId}/coming, no body — a caretaker's "I'm on my way" (member cookie). */
export async function POST(request: NextRequest, { params }: Context) {
  const { helpId } = await params;
  return circleRoute("circle.help.coming", null, async () => walkerJson(await circleService().helpComing(memberCaller(request), helpId)));
}
