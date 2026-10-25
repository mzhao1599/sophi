import type { NextRequest } from "next/server";
import { SpeechPaceRequestSchema } from "@walker/contracts";
import { ownerCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** PUT /api/v1/walkers/{id}/speech-pace — the page's Slower / Normal / Faster for Sophi's voice. */
export async function PUT(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return walkerRoute("walkers.speech_pace", id, async () => {
    const body = await readJson(request, SpeechPaceRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().setSpeechPace(ownerCaller(request), id, body.speech_pace));
  });
}
