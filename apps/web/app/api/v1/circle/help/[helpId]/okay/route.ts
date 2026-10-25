import type { NextRequest } from "next/server";
import { circleRoute, circleService, memberCaller } from "@/server/circle";
import { walkerJson } from "@/server/walker";

type Context = { params: Promise<{ helpId: string }> };

/** POST /api/v1/circle/help/{helpId}/okay, no body — her phone's "I'm okay now", or a caretaker's "I'm with her". */
export async function POST(request: NextRequest, { params }: Context) {
  const { helpId } = await params;
  return circleRoute("circle.help.okay", null, async () => walkerJson(await circleService().helpOkay(memberCaller(request), helpId)));
}
