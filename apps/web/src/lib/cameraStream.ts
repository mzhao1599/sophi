import { CAMERA_BOUNDARY, CameraSourceSchema, type CameraSource } from "@walker/contracts";

/** One frame off the live stream (camera.ts in the contracts, "GET /api/v1/circle/camera/live"). */
export interface LiveFrame {
  jpeg: Uint8Array;
  seq: number;
  source: CameraSource;
  /** How long the server had held it when it sent it. */
  ageMs: number;
}

const DASHES = new TextEncoder().encode(`--${CAMERA_BOUNDARY}\r\n`);
const HEAD_END = new TextEncoder().encode("\r\n\r\n");
/** No part's headers are anywhere near this long; more means the stream isn't ours. */
const MAX_HEAD_BYTES = 1_024;

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Turns the stream's chunks back into frames. Chunks split anywhere, so it keeps the unread tail; a part it
 * can't read (no Content-Length, an unknown source) is skipped up to the next boundary rather than shown.
 */
export class LiveFrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): LiveFrame[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const frames: LiveFrame[] = [];
    for (;;) {
      const start = indexOf(this.buffer, DASHES);
      if (start < 0) {
        // Keep only what could still be the start of a boundary.
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - DASHES.length + 1));
        return frames;
      }
      const headStart = start + DASHES.length;
      const headEnd = indexOf(this.buffer, HEAD_END, headStart);
      if (headEnd < 0) {
        if (this.buffer.length - headStart > MAX_HEAD_BYTES) this.buffer = this.buffer.slice(headStart);
        else this.buffer = this.buffer.slice(start);
        return frames;
      }
      const headers = new Map<string, string>();
      for (const line of new TextDecoder().decode(this.buffer.slice(headStart, headEnd)).split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const length = Number(headers.get("content-length"));
      const bodyStart = headEnd + HEAD_END.length;
      if (!Number.isInteger(length) || length < 0) {
        this.buffer = this.buffer.slice(bodyStart);
        continue;
      }
      if (this.buffer.length < bodyStart + length) {
        this.buffer = this.buffer.slice(start);
        return frames;
      }
      const jpeg = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      const source = CameraSourceSchema.safeParse(headers.get("x-frame-source"));
      const seq = Number(headers.get("x-frame-seq"));
      if (source.success && Number.isInteger(seq)) frames.push({ jpeg, seq, source: source.data, ageMs: Math.max(0, Number(headers.get("x-frame-age-ms")) || 0) });
    }
  }
}
