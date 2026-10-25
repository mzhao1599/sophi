import { SPEECH_MAX_BYTES } from "@walker/contracts";

/**
 * Sophi's spoken voice, from Cartesia's text-to-speech. Only the text of Sophi's reply is sent (a
 * reply can repeat some of the person's words), never their clip. The request shape follows
 * docs.cartesia.ai/api-reference/tts/bytes: `POST /tts/bytes`, `Authorization: Bearer`,
 * `Cartesia-Version: 2026-08-14` (the only value that page allows; a bulk date edit once changed it to an
 * invalid one), model `sonic-3.6` (which follows Cartesia's latest stable snapshot), and a stock voice by
 * id (never a cloned one). Any failure returns null, and the walker speaks the reply with its own voice.
 */

const TTS_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_VERSION = "2026-08-14";
export const DEFAULT_CARTESIA_MODEL = "sonic-3.6";
/** "Skylar", an en-US stock voice Cartesia's model page recommends for voice agents. */
export const DEFAULT_CARTESIA_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

export interface WalkerVoice {
  /** The reply as mono 16-bit WAV (16 kHz unless the voice was made with another rate) in base64, or null when it couldn't be made in time. */
  speak(text: string, signal: AbortSignal): Promise<string | null>;
}

export interface CartesiaVoiceOptions {
  apiKey: string;
  voiceId?: string;
  model?: string;
  /** 16 kHz is what the walker's player takes; the onboarding page asks for 24 kHz, which sounds clearer on a laptop. */
  sampleRate?: 16_000 | 24_000;
  /** For tests: answers requests instead of the network. */
  fetch?: typeof fetch;
}

export function createCartesiaVoice({ apiKey, voiceId = DEFAULT_CARTESIA_VOICE, model = DEFAULT_CARTESIA_MODEL, sampleRate = 16_000, fetch: fetchImpl = fetch }: CartesiaVoiceOptions): WalkerVoice {
  return {
    async speak(text, signal) {
      try {
        const response = await fetchImpl(TTS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "cartesia-version": CARTESIA_VERSION, "content-type": "application/json" },
          body: JSON.stringify({
            model_id: model,
            transcript: text,
            voice: { id: voiceId },
            output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: sampleRate },
            language: "en",
          }),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const audio = await readCapped(response, SPEECH_MAX_BYTES);
        return audio && (wavMonoBytes(audio, sampleRate) ?? 0) > 0 ? audio.toString("base64") : null;
      } catch {
        // A timeout, a dropped connection or a bad key: the walker speaks for itself.
        return null;
      }
    },
  };
}

/**
 * How Sophi hears a Talk press: Cartesia's batch speech-to-text turns the clip into words, and Claude then
 * reads the words (the Messages API takes no audio). The clip goes to Cartesia and nowhere else. The request
 * shape follows docs.cartesia.ai/api-reference/stt/transcribe: `POST /stt`, multipart `file`, `model`
 * `ink-whisper`, `language` `en`, and `Cartesia-Version: 2026-08-14`, the only version that page allows.
 */
const STT_URL = "https://api.cartesia.ai/stt";
export const DEFAULT_CARTESIA_STT_MODEL = "ink-whisper";
/** A transcript longer than the contract's `heard` limit is cut there. */
const MAX_HEARD = 1_000;

export interface WalkerEars {
  /** The words in a 16 kHz mono WAV clip: "" when none were made out, null when Cartesia couldn't be asked or failed. */
  transcribe(wav: Buffer, signal: AbortSignal): Promise<string | null>;
}

export function createCartesiaEars({ apiKey, model = DEFAULT_CARTESIA_STT_MODEL, fetch: fetchImpl = fetch }: { apiKey: string; model?: string; fetch?: typeof fetch }): WalkerEars {
  return {
    async transcribe(wav, signal) {
      try {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "talk.wav");
        form.append("model", model);
        form.append("language", "en");
        const response = await fetchImpl(STT_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "cartesia-version": CARTESIA_VERSION },
          body: form,
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const data = (await response.json()) as { text?: unknown };
        return typeof data.text === "string" ? data.text.trim().slice(0, MAX_HEARD) : null;
      } catch {
        // A timeout, a dropped connection or a bad key: the turn answers with its fixed "didn't hear" line.
        return null;
      }
    },
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * True for a RIFF/WAVE file whose format chunk says PCM (format 1), one channel, 16,000 samples a
 * second and 16 bits a sample, followed by a data chunk with samples in it: what the walker records,
 * and what the Pi's player accepts (devices/pi readWav), so a reply sent as speech is one it can play.
 */
export function isWav16kMono(wav: Buffer): boolean {
  return (wavMonoBytes(wav, 16_000) ?? 0) > 0;
}

/** The clip's length in milliseconds, from the samples actually there (16 kHz mono 16-bit is 32 bytes a millisecond). */
export function wav16kMonoMs(wav: Buffer): number | null {
  const bytes = wavMonoBytes(wav, 16_000);
  return bytes === null ? null : Math.round(bytes / 32);
}

/** The bytes of samples in a mono 16-bit PCM WAV at `rate` samples a second, or null when it isn't one. */
function wavMonoBytes(wav: Buffer, rate: number): number | null {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmtOk: boolean | null = null;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= wav.length) {
      fmtOk = wav.readUInt16LE(body) === 1 && wav.readUInt16LE(body + 2) === 1 && wav.readUInt32LE(body + 4) === rate && wav.readUInt16LE(body + 14) === 16;
    } else if (id === "data") {
      // Streaming encoders may leave the size at 0xFFFFFFFF; what counts is the samples actually there.
      return fmtOk === true ? Math.max(0, Math.min(wav.length, body + size) - body) : null;
    }
    at = body + size + (size % 2);
  }
  return null;
}
