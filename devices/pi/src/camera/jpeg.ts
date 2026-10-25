/**
 * Splits ffmpeg's MJPEG stream into whole JPEG frames, and gives frames without Huffman tables the standard ones.
 *
 * The splitter walks each frame's structure instead of looking for the end bytes: marker segments are skipped
 * by their length until the start of scan (SOS), and only then is the compressed data scanned for the next
 * marker. Inside that data a real 0xFF byte is always followed by 0x00 (byte stuffing) or a restart marker, so
 * the first other marker after the scan is where the scan ends: EOI ends the frame, anything else starts the
 * next segment (a progressive JPEG has several scans). An `FF D9` inside an APP segment, such as an EXIF
 * thumbnail, therefore can't end a frame early.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DHT = 0xc4;
const TEM = 0x01;

/** Restart markers (RST0–RST7) and TEM stand alone, without a length. */
function standalone(marker: number): boolean {
  return (marker >= 0xd0 && marker <= 0xd7) || marker === TEM;
}

export class JpegSplitter {
  /** Frames dropped for being over the size limit or cut off by a new start of image. */
  dropped = 0;
  private buf: Buffer = Buffer.alloc(0);
  /** Where parsing resumes in `buf`; `buf` always starts at a frame's SOI once one has been found. */
  private pos = 0;
  private inScan = false;
  private synced = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onFrame: (jpeg: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (!this.synced && !this.sync()) return;
      const result = this.parse();
      if (result === "more") {
        if (this.buf.length > this.maxBytes) this.drop(this.pos);
        else return;
      }
    }
  }

  /** Finds the next SOI and makes it the start of `buf`; false (keeping a trailing 0xFF) when there is none yet. */
  private sync(): boolean {
    const at = this.buf.indexOf(Buffer.from([0xff, SOI]));
    if (at < 0) {
      this.buf = this.buf.length > 0 && this.buf[this.buf.length - 1] === 0xff ? this.buf.subarray(this.buf.length - 1) : Buffer.alloc(0);
      return false;
    }
    this.buf = this.buf.subarray(at);
    this.pos = 2;
    this.inScan = false;
    this.synced = true;
    return true;
  }

  /** Throws the current frame away and looks for the next SOI from `from`. */
  private drop(from: number, counted = true) {
    if (counted) this.dropped += 1;
    this.buf = this.buf.subarray(Math.max(1, from));
    this.synced = false;
    this.inScan = false;
  }

  /** Parses from `pos`: "done" after emitting or dropping a frame, "more" when the bytes run out. */
  private parse(): "done" | "more" {
    const b = this.buf;
    for (;;) {
      if (this.inScan) {
        // Compressed data: find an 0xFF that isn't stuffing, a restart marker or fill.
        for (;;) {
          const ff = b.indexOf(0xff, this.pos);
          if (ff < 0 || ff + 1 >= b.length) {
            this.pos = ff < 0 ? b.length : ff;
            return "more";
          }
          const next = b[ff + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            this.pos = ff + 1;
            continue;
          }
          this.pos = ff;
          this.inScan = false;
          break;
        }
      }
      if (this.pos + 1 >= b.length) return "more";
      if (b[this.pos] !== 0xff) {
        this.drop(this.pos);
        return "done";
      }
      const marker = b[this.pos + 1]!;
      if (marker === 0xff) {
        this.pos += 1; // A fill byte before a marker.
        continue;
      }
      if (marker === EOI) {
        const end = this.pos + 2;
        if (end > this.maxBytes) this.dropped += 1;
        else this.onFrame(Buffer.from(b.subarray(0, end)));
        this.buf = b.subarray(end);
        this.synced = false;
        return "done";
      }
      if (marker === SOI) {
        // A new image began before this one ended: this one was cut off.
        this.drop(this.pos);
        return "done";
      }
      if (standalone(marker)) {
        this.pos += 2;
        continue;
      }
      if (this.pos + 3 >= b.length) return "more";
      const length = b.readUInt16BE(this.pos + 2);
      if (length < 2) {
        this.drop(this.pos + 1);
        return "done";
      }
      const next = this.pos + 2 + length;
      if (next > b.length) {
        if (next > this.maxBytes) {
          this.drop(this.pos);
          return "done";
        }
        return "more";
      }
      this.pos = next;
      if (marker === SOS) this.inScan = true;
    }
  }
}

// The standard Huffman tables from ITU-T T.81 Annex K.3 (K.3.3.1 and K.3.3.2): per table, the number of codes
// of each length 1 to 16, then the values. UVC cameras encode with these and often leave them out of the frame.
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** The four tables as one DHT segment (class/id 0x00, 0x10, 0x01, 0x11), marker included. */
export const STANDARD_DHT: Buffer = (() => {
  const tables: Array<[number, number[], number[]]> = [
    [0x00, DC_LUMA_BITS, DC_VALUES],
    [0x10, AC_LUMA_BITS, AC_LUMA_VALUES],
    [0x01, DC_CHROMA_BITS, DC_VALUES],
    [0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES],
  ];
  const body = tables.flatMap(([id, bits, values]) => [id, ...bits, ...values]);
  const length = body.length + 2;
  return Buffer.from([0xff, DHT, length >> 8, length & 0xff, ...body]);
})();

/**
 * The frame with the standard Huffman tables inserted right before its first SOS, when it has no DHT of its
 * own (browsers can't decode such a frame). A frame that has one, or whose segments can't be walked, is
 * returned unchanged.
 */
export function withHuffmanTables(jpeg: Buffer): Buffer {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== SOI) return jpeg;
  let pos = 2;
  while (pos + 3 < jpeg.length) {
    if (jpeg[pos] !== 0xff) return jpeg;
    const marker = jpeg[pos + 1]!;
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === DHT) return jpeg;
    if (marker === SOS) return Buffer.concat([jpeg.subarray(0, pos), STANDARD_DHT, jpeg.subarray(pos)]);
    if (standalone(marker)) {
      pos += 2;
      continue;
    }
    if (marker === EOI || marker === SOI) return jpeg;
    const length = jpeg.readUInt16BE(pos + 2);
    if (length < 2) return jpeg;
    pos += 2 + length;
  }
  return jpeg;
}
