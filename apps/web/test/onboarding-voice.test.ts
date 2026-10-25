import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWav16kMono, wav16kMonoMs } from "@walker/cloud-api";
import { downsample, encodeWav } from "@/lib/voice";
import { resetVoiceBudgetForTests, setOnboardingVoiceForTests, type OnboardingVoice } from "@/server/voice";
import * as hear from "../app/api/v1/onboarding/voice/hear/route";
import * as speak from "../app/api/v1/onboarding/voice/speak/route";

/**
 * Onboarding by voice: the page records a 16 kHz WAV, the hear route sends it to Cartesia (a stub here) for
 * the words, and the speak route returns a reply in Cartesia's voice. Live Cartesia isn't called in tests.
 */

const BASE = "http://localhost:3006";

function clip(ms: number): Buffer {
  return Buffer.from(encodeWav(new Float32Array(16 * ms).map((_, i) => Math.sin(i / 8) * 0.3)));
}

function hearRequest(body: Buffer | string, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/v1/onboarding/voice/hear`, { method: "POST", headers: { "content-type": "audio/wav", "sec-fetch-site": "same-origin", ...headers }, body: new Uint8Array(Buffer.from(body)) });
}

function speakRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/v1/onboarding/voice/speak`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });
}

let heard: Buffer[] = [];
let spoken: string[] = [];
function stub({ words = "Small buttons are hard for me" as string | null, audio = "UklGRg==" as string | null } = {}): OnboardingVoice {
  return {
    ears: { transcribe: async (wav) => (heard.push(wav), words) },
    voice: { speak: async (text) => (spoken.push(text), audio) },
  };
}

beforeEach(() => {
  heard = [];
  spoken = [];
  resetVoiceBudgetForTests();
  setOnboardingVoiceForTests(stub());
});
afterEach(() => setOnboardingVoiceForTests(undefined));

describe("the page's recording", () => {
  it("is a 16 kHz mono 16-bit WAV the server's own check accepts, with its real length", () => {
    const wav = clip(1500);
    expect(isWav16kMono(wav)).toBe(true);
    expect(wav16kMonoMs(wav)).toBe(1500);
  });

  it("downsamples 48 kHz to 16 kHz by averaging, and keeps 16 kHz as it is", () => {
    const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1]);
    expect([...downsample(input, 48_000)].map((x) => Math.round(x * 100) / 100)).toEqual([0.3, 1]);
    expect(downsample(input, 16_000)).toBe(input);
    expect(downsample(new Float32Array(44_100), 44_100)).toHaveLength(16_000);
  });

  it("clips samples outside -1..1 instead of wrapping", () => {
    const wav = Buffer.from(encodeWav(new Float32Array([2, -2])));
    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32768);
  });
});

describe("POST /api/v1/onboarding/voice/hear", () => {
  it("returns Cartesia's words for a clip, sending the clip unchanged", async () => {
    const wav = clip(1200);
    const response = await hear.POST(hearRequest(wav));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Small buttons are hard for me" });
    expect(heard).toEqual([wav]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns empty text when Cartesia made out no words, and 503 when it couldn't be asked", async () => {
    setOnboardingVoiceForTests(stub({ words: "" }));
    expect(await (await hear.POST(hearRequest(clip(500)))).json()).toEqual({ text: "" });
    setOnboardingVoiceForTests(stub({ words: null }));
    const failed = await hear.POST(hearRequest(clip(500)));
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.message).toMatch(/type it/);
  });

  it("refuses what isn't a short 16 kHz WAV, before calling Cartesia", async () => {
    expect((await hear.POST(hearRequest(clip(500), { "content-type": "audio/webm" }))).status).toBe(415);
    expect((await hear.POST(hearRequest("not a wav file at all"))).status).toBe(400);
    const at44k = Buffer.from(encodeWav(new Float32Array(4410), 44_100));
    expect((await hear.POST(hearRequest(at44k))).status).toBe(400);
    expect((await hear.POST(hearRequest(clip(31_000)))).status).toBe(413);
    expect(heard).toEqual([]);
  });

  it("answers only this site's own pages", async () => {
    const response = await hear.POST(hearRequest(clip(500), { "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(heard).toEqual([]);
  });

  it("is off without a Cartesia key", async () => {
    setOnboardingVoiceForTests(null);
    expect((await hear.POST(hearRequest(clip(500)))).status).toBe(503);
  });

  it("allows 40 requests a minute from one address, then says to wait", async () => {
    for (let i = 0; i < 40; i++) expect((await hear.POST(hearRequest(clip(100)))).status).toBe(200);
    const refused = await hear.POST(hearRequest(clip(100)));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("rate_limited");
  });
});

describe("POST /api/v1/onboarding/voice/speak", () => {
  it("returns the reply as WAV audio in Cartesia's voice", async () => {
    const response = await speak.POST(speakRequest({ text: "What's hardest for you day to day?" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("UklGRg==", "base64"));
    expect(spoken).toEqual(["What's hardest for you day to day?"]);
  });

  it("refuses empty or long text, other sites, and says when Cartesia failed", async () => {
    expect((await speak.POST(speakRequest({ text: "  " }))).status).toBe(400);
    expect((await speak.POST(speakRequest({ text: "a".repeat(601) }))).status).toBe(400);
    expect((await speak.POST(speakRequest({ text: "Hi", extra: 1 }))).status).toBe(400);
    expect((await speak.POST(speakRequest({ text: "Hi" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(spoken).toEqual([]);
    setOnboardingVoiceForTests(stub({ audio: null }));
    expect((await speak.POST(speakRequest({ text: "Hi" }))).status).toBe(503);
  });
});
