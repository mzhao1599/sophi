/** 16-bit PCM WAV helpers: the voice clip format (16 kHz mono) and the generated cue sounds. */

export const WAV_HEADER_BYTES = 44;

export function wavFromPcm(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = sampleRate * channels * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: number;
  pcm: Buffer;
}

/** Reads a RIFF/WAVE file's format and PCM data, walking its chunks (ffmpeg adds a LIST chunk). */
export function readWav(file: Buffer): WavInfo {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "pcm"> | null = null;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= file.length) {
      fmt = {
        format: file.readUInt16LE(body),
        channels: file.readUInt16LE(body + 2),
        sampleRate: file.readUInt32LE(body + 4),
        bitsPerSample: file.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data comes before its format.");
      return { ...fmt, pcm: file.subarray(body, Math.min(file.length, body + size)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data.");
}

/** A short sine sequence with 5 ms fades, so cue sounds don't click. */
export function toneWav(notes: ReadonlyArray<{ hz: number; ms: number }>, sampleRate = 16000, volume = 0.4): Buffer {
  const samples: number[] = [];
  for (const note of notes) {
    const count = Math.round((note.ms / 1000) * sampleRate);
    const fade = Math.min(Math.round(0.005 * sampleRate), Math.floor(count / 2));
    for (let i = 0; i < count; i += 1) {
      const envelope = note.hz === 0 ? 0 : Math.min(1, i / Math.max(fade, 1), (count - 1 - i) / Math.max(fade, 1));
      samples.push(Math.round(Math.sin((2 * Math.PI * note.hz * i) / sampleRate) * envelope * volume * 32767));
    }
  }
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => pcm.writeInt16LE(sample, i * 2));
  return wavFromPcm(pcm, sampleRate);
}

/** The six generated cue sounds. Each is under half a second. `help`: both handle buttons are down (a calm rising three-note). */
export const CUE_TONES = {
  listening: [
    { hz: 660, ms: 90 },
    { hz: 880, ms: 110 },
  ],
  done: [
    { hz: 880, ms: 90 },
    { hz: 660, ms: 110 },
  ],
  error: [{ hz: 220, ms: 280 }],
  nothing_to_confirm: [
    { hz: 330, ms: 80 },
    { hz: 0, ms: 60 },
    { hz: 330, ms: 80 },
  ],
  obstacle: [
    { hz: 1250, ms: 70 },
    { hz: 0, ms: 50 },
    { hz: 1250, ms: 70 },
  ],
  help: [
    { hz: 523, ms: 110 },
    { hz: 659, ms: 110 },
    { hz: 784, ms: 160 },
  ],
} as const;
