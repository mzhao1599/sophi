import { describe, expect, it } from "vitest";
import { createCartesiaVoice } from "../../src/walker/speech";

/** A mono 16-bit PCM WAV of `ms` milliseconds of silence at `rate`. */
function wavAt(rate: number, ms: number): Buffer {
  const data = Math.round((rate * 2 * ms) / 1000);
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

function voiceAnswering(audio: Buffer, sampleRate?: 16_000 | 24_000) {
  const bodies: unknown[] = [];
  const voice = createCartesiaVoice({
    apiKey: "sk_car_test",
    sampleRate,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return new Response(new Uint8Array(audio), { status: 200 });
    },
  });
  return { voice, bodies };
}

describe("the Cartesia voice's sample rate (onboarding asks for 24 kHz; the walker keeps 16 kHz)", () => {
  it("asks for 24 kHz and accepts a 24 kHz WAV", async () => {
    const audio = wavAt(24_000, 300);
    const { voice, bodies } = voiceAnswering(audio, 24_000);
    expect(await voice.speak("Hello.", AbortSignal.timeout(1000))).toBe(audio.toString("base64"));
    expect(bodies[0]).toMatchObject({ output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 24_000 } });
  });

  it("refuses audio at a different rate from the one asked for", async () => {
    expect(await voiceAnswering(wavAt(16_000, 300), 24_000).voice.speak("Hello.", AbortSignal.timeout(1000))).toBeNull();
    expect(await voiceAnswering(wavAt(24_000, 300)).voice.speak("Hello.", AbortSignal.timeout(1000))).toBeNull();
  });

  it("keeps 16 kHz when no rate is given", async () => {
    const audio = wavAt(16_000, 300);
    const { voice, bodies } = voiceAnswering(audio);
    expect(await voice.speak("Hello.", AbortSignal.timeout(1000))).toBe(audio.toString("base64"));
    expect(bodies[0]).toMatchObject({ output_format: { sample_rate: 16_000 } });
  });
});
