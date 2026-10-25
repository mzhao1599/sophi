"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Onboarding's voice, in the browser. The microphone is a toggle (press to start, press again to send), never
 * a press-and-hold, so it needs no fine-motor gesture; typing always works too. The recording is turned into
 * a 16 kHz mono WAV here, the same format the walker records, and sent to the server, which asks Cartesia for
 * the words. Replies are read aloud from the server's Cartesia audio when "Read aloud" is on.
 */

export const CLIP_RATE = 16_000;
/** A spoken answer stops itself here and is sent, matching the server's limit. */
export const MAX_LISTEN_MS = 30_000;

/** Resamples to `toRate`: averages blocks when the input is faster (the usual 44.1 or 48 kHz), interpolates when slower. */
export function downsample(input: Float32Array, fromRate: number, toRate = CLIP_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j]!;
      out[i] = end > start ? sum / (end - start) : 0;
    } else {
      const at = i * ratio;
      const j = Math.floor(at);
      const a = input[j] ?? 0;
      out[i] = a + ((input[j + 1] ?? a) - a) * (at - j);
    }
  }
  return out;
}

/** Samples in -1..1 as a mono 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, rate = CLIP_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const clamped = Math.max(-1, Math.min(1, s));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return buffer;
}

interface Recording {
  /** Stops the microphone and returns what was said as a WAV. */
  stop(): Blob;
  /** Stops the microphone and throws the recording away. */
  cancel(): void;
}

async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode is old but works in every browser without loading a worklet file; it only copies samples.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(context.destination); // silent: the output buffer is never written
  const close = () => {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };
  return {
    stop() {
      close();
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      return new Blob([encodeWav(downsample(all, context.sampleRate))], { type: "audio/wav" });
    },
    cancel: close,
  };
}

export type VoiceState = "idle" | "listening" | "hearing";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

/**
 * The microphone and read-aloud state for the chat. `onWords` gets what Cartesia heard ("" when it made out
 * nothing). Errors are short sentences for the page.
 */
export function useVoice(onWords: (text: string) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [readAloud, setReadAloud] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recording = useRef<Recording | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const speakRequest = useRef<AbortController | null>(null);
  const wordsRef = useRef(onWords);
  useEffect(() => {
    wordsRef.current = onWords;
  });

  const stopSpeaking = useCallback(() => {
    speakRequest.current?.abort();
    speakRequest.current = null;
    if (audio.current) {
      audio.current.pause();
      URL.revokeObjectURL(audio.current.src);
      audio.current = null;
    }
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      stopSpeaking();
      const request = new AbortController();
      speakRequest.current = request;
      try {
        const response = await fetch("/api/v1/onboarding/voice/speak", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: text.slice(0, 600) }),
          signal: request.signal,
        });
        if (!response.ok) throw new Error(await errorMessage(response, "Couldn't read that aloud."));
        const url = URL.createObjectURL(await response.blob());
        if (request.signal.aborted) return URL.revokeObjectURL(url);
        const player = new Audio(url);
        audio.current = player;
        player.onended = () => {
          if (audio.current === player) stopSpeaking();
        };
        setSpeaking(true);
        await player.play();
      } catch (e) {
        if (request.signal.aborted) return;
        setSpeaking(false);
        setError(e instanceof Error && e.name !== "NotAllowedError" ? e.message : "Couldn't read that aloud.");
      }
    },
    [stopSpeaking],
  );

  const finish = useCallback(async () => {
    if (limit.current) clearTimeout(limit.current);
    const current = recording.current;
    recording.current = null;
    if (!current) return;
    const clip = current.stop();
    setState("hearing");
    try {
      const response = await fetch("/api/v1/onboarding/voice/hear", { method: "POST", headers: { "content-type": "audio/wav" }, body: clip });
      if (!response.ok) throw new Error(await errorMessage(response, "I couldn't hear that. Please try again, or type it."));
      const body = (await response.json()) as { text?: unknown };
      setState("idle");
      wordsRef.current(typeof body.text === "string" ? body.text.trim() : "");
    } catch (e) {
      setState("idle");
      setError(e instanceof Error ? e.message : "I couldn't hear that. Please try again, or type it.");
    }
  }, []);

  /** Starts listening, or (when already listening) stops and sends what was said. */
  const toggleListening = useCallback(async () => {
    if (state === "hearing") return;
    if (state === "listening") return finish();
    setError(null);
    stopSpeaking();
    try {
      recording.current = await startRecording();
      setState("listening");
      limit.current = setTimeout(() => void finish(), MAX_LISTEN_MS);
    } catch (e) {
      const blocked = e instanceof Error && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setError(blocked ? "The microphone is blocked. Allow it for this site, or type instead." : "No microphone was found. You can type instead.");
    }
  }, [state, finish, stopSpeaking]);

  useEffect(
    () => () => {
      if (limit.current) clearTimeout(limit.current);
      recording.current?.cancel();
      stopSpeaking();
    },
    [stopSpeaking],
  );

  return { state, readAloud, setReadAloud, speaking, speak, stopSpeaking, toggleListening, error, clearError: () => setError(null) };
}
