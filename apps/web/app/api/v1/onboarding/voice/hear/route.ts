import { isWav16kMono, wav16kMonoMs } from "@walker/cloud-api";
import { errorResponse, handle, json } from "@/server/onboarding";
import { HEAR_MAX_BYTES, HEAR_MAX_MS, VOICE_TIMEOUT_MS, crossSite, onboardingVoice, overBudget } from "@/server/voice";

/**
 * POST /api/v1/onboarding/voice/hear — a spoken answer (16 kHz mono 16-bit WAV, at most 30 seconds) in, its
 * words out as `{ text }` ("" when none were made out). Cartesia's speech-to-text does the hearing; the clip
 * isn't kept. The page sends the words as the person's reply, so they see what was heard.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const voice = onboardingVoice();
    if (!voice) return errorResponse("unavailable", 503, "Voice isn't set up on this server. Please type instead.");
    const refused = crossSite(request) ?? overBudget(request);
    if (refused) return refused;
    if (!request.headers.get("content-type")?.startsWith("audio/wav")) return errorResponse("invalid_request", 415, "Send the recording as audio/wav.");
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > HEAR_MAX_BYTES) return errorResponse("invalid_request", 413, "That recording is too long. Keep it under 30 seconds.");
    const clip = Buffer.from(await request.arrayBuffer());
    if (clip.length > HEAR_MAX_BYTES) return errorResponse("invalid_request", 413, "That recording is too long. Keep it under 30 seconds.");
    if (!isWav16kMono(clip) || (wav16kMonoMs(clip) ?? 0) > HEAR_MAX_MS) return errorResponse("invalid_request", 400, "That recording isn't one this page can read.");
    const text = await voice.ears.transcribe(clip, AbortSignal.timeout(VOICE_TIMEOUT_MS));
    if (text === null) return errorResponse("unavailable", 503, "I couldn't hear that just now. Please try again, or type it.");
    return json({ text });
  });
}
