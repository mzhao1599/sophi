import "server-only";
import { createCartesiaEars, createCartesiaVoice, type WalkerEars, type WalkerVoice } from "@walker/cloud-api";
import { clientAddress } from "./walker";
import { errorResponse } from "./onboarding";

/**
 * Onboarding's voice: Cartesia turns a spoken answer into words (the same speech-to-text as a Talk press on
 * the walker) and reads the assistant's replies aloud in Sophi's voice. The key is CARTESIA_API_KEY, read
 * here on the server and never sent to the browser. Without it (or set to "none") the page shows no
 * microphone and no read-aloud switch, and typing works as before.
 *
 * Nothing is stored: a clip goes to Cartesia and its words come back to the page, which sends them as the
 * person's reply; a reply's text goes to Cartesia and the audio goes straight back to the page.
 */

export interface OnboardingVoice {
  ears: WalkerEars;
  voice: WalkerVoice;
}

const globalForVoice = globalThis as unknown as { __onboardingVoice?: OnboardingVoice | null };

export function onboardingVoice(env: Record<string, string | undefined> = process.env): OnboardingVoice | null {
  if (globalForVoice.__onboardingVoice !== undefined) return globalForVoice.__onboardingVoice;
  const key = env.CARTESIA_API_KEY?.trim();
  const voiceId = env.CARTESIA_VOICE_ID?.trim() || undefined;
  globalForVoice.__onboardingVoice =
    key && key.toLowerCase() !== "none"
      ? { ears: createCartesiaEars({ apiKey: key }), voice: createCartesiaVoice({ apiKey: key, voiceId: voiceId?.toLowerCase() === "none" ? undefined : voiceId, sampleRate: 24_000 }) }
      : null;
  return globalForVoice.__onboardingVoice;
}

/** For tests: forget the cached voice so the next call reads `env` again, or use the one given. */
export function setOnboardingVoiceForTests(voice: OnboardingVoice | null | undefined) {
  globalForVoice.__onboardingVoice = voice;
}

/** A spoken answer: 16 kHz mono 16-bit WAV, at most 30 seconds (32 bytes a millisecond, plus the header). */
export const HEAR_MAX_MS = 30_000;
export const HEAR_MAX_BYTES = HEAR_MAX_MS * 32 + 1_024;
/** A reply read aloud: the onboarding replies are short; this keeps the route from being a general speech service. */
export const SPEAK_MAX_CHARS = 600;
/** Cartesia's time for one request. Typing is always there if it is slower. */
export const VOICE_TIMEOUT_MS = 8_000;

/**
 * The routes answer only this site's own pages (the browser marks a same-origin fetch), so another site
 * can't spend the key through a visitor's browser.
 */
export function crossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin") return null;
  return errorResponse("unauthenticated", 403, "Voice works from Sophi's own page.");
}

// A small per-address budget so one visitor can't run up the Cartesia bill: 40 requests a minute covers a
// fast conversation (one clip and one reply a turn) several times over.
const WINDOW_MS = 60_000;
const BUDGET = 40;
const globalForBudget = globalThis as unknown as { __voiceBudget?: Map<string, number[]> };

export function overBudget(request: Request, now = Date.now()): Response | null {
  const seen = (globalForBudget.__voiceBudget ??= new Map<string, number[]>());
  const address = clientAddress(request.headers);
  const recent = (seen.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= BUDGET) {
    seen.set(address, recent);
    return errorResponse("rate_limited", 429, "That's a lot of talking at once. Please wait a minute, or type instead.");
  }
  recent.push(now);
  seen.set(address, recent);
  if (seen.size > 10_000) seen.clear();
  return null;
}

export function resetVoiceBudgetForTests() {
  globalForBudget.__voiceBudget = new Map();
}
