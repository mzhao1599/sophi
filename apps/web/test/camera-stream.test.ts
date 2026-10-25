import { describe, expect, it } from "vitest";
import { cameraPart, type CameraFrame } from "@walker/cloud-api";
import { LiveFrameReader } from "@/lib/cameraStream";

/**
 * The phone's reader for the live camera's multipart stream, fed by the server's own part encoder.
 * Expected, written before the run: every frame comes back byte for byte with its seq, source and age,
 * however the stream is split (here at every byte); bytes before the first boundary are ignored; a part
 * with an unknown source or no length is skipped, and the frame after it still arrives.
 */

function frame(seq: number, fill: number, source: CameraFrame["source"] = "camera"): CameraFrame {
  const bytes = new Uint8Array(300 + seq).fill(fill);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  // Bytes that look like the boundary's start and a header end, inside the JPEG.
  bytes.set(new TextEncoder().encode("\r\n\r\n--walker-camera-frame\r\n"), 40);
  return { bytes, seq, source, received_at: 0 };
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("live camera stream reader", () => {
  const frames = [frame(1, 0x11), frame(2, 0x22, "test_pattern"), frame(3, 0x33)];
  const stream = concat(frames.map((f, i) => cameraPart(f, i * 40)));

  it("reads every frame however the stream is split", () => {
    for (let cut = 1; cut < stream.length; cut++) {
      const reader = new LiveFrameReader();
      const got = [...reader.push(stream.slice(0, cut)), ...reader.push(stream.slice(cut))];
      expect(got.map((g) => [g.seq, g.source, g.ageMs])).toEqual([
        [1, "camera", 0],
        [2, "test_pattern", 40],
        [3, "camera", 80],
      ]);
      expect(got.map((g) => g.jpeg)).toEqual(frames.map((f) => f.bytes));
    }
  });

  it("reads byte by byte", () => {
    const reader = new LiveFrameReader();
    const got = [];
    for (let i = 0; i < stream.length; i++) got.push(...reader.push(stream.slice(i, i + 1)));
    expect(got.map((g) => g.seq)).toEqual([1, 2, 3]);
  });

  it("ignores bytes before the first boundary and skips a part it can't read", () => {
    const enc = new TextEncoder();
    const bad = enc.encode("--walker-camera-frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nX-Frame-Seq: 9\r\nX-Frame-Source: webcam\r\nX-Frame-Age-Ms: 0\r\n\r\nabcd\r\n");
    const noLength = enc.encode("--walker-camera-frame\r\nContent-Type: image/jpeg\r\n\r\n");
    const reader = new LiveFrameReader();
    const got = reader.push(concat([enc.encode("garbage\r\n"), bad, noLength, cameraPart(frame(4, 0x44), 5)]));
    expect(got.map((g) => g.seq)).toEqual([4]);
    expect(got[0]!.jpeg).toEqual(frame(4, 0x44).bytes);
  });
});
