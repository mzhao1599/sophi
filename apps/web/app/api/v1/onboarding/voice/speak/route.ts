import { z } from "zod";
import { errorResponse, handle, parseBody } from "@/server/onboarding";
import { SPEAK_MAX_CHARS, VOICE_TIMEOUT_MS, crossSite, onboardingVoice, overBudget } from "@/server/voice";

const SpeakRequestSchema = z.strictObject({ text: z.string().trim().min(1, "Say something to read aloud.").max(SPEAK_MAX_CHARS, "That's too long to read aloud.") });

/**
 * POST /api/v1/onboarding/voice/speak — `{ text }` in (an assistant reply the page is showing), the reply
 * read aloud in Cartesia's Sonic voice out, as 24 kHz mono WAV. Nothing is kept.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const voice = onboardingVoice();
    if (!voice) return errorResponse("unavailable", 503, "Voice isn't set up on this server.");
    const refused = crossSite(request) ?? overBudget(request);
    if (refused) return refused;
    const body = await parseBody(request, SpeakRequestSchema);
    if (body instanceof Response) return body;
    const audio = await voice.voice.speak(body.text, AbortSignal.timeout(VOICE_TIMEOUT_MS));
    if (!audio) return errorResponse("unavailable", 503, "Couldn't read that aloud just now.");
    return new Response(Buffer.from(audio, "base64"), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  });
}
