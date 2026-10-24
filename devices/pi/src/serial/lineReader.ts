import { SERIAL_MAX_LINE_BYTES, parseSerialLine, type SerialParseResult } from "@walker/contracts";

/**
 * Splits a serial byte stream into JSON Lines and parses each one with the shared `parseSerialLine`.
 *
 * The buffer never holds more than one line's worth of bytes (1,024 counting the `\n`). A longer line is
 * reported once as `oversize`, dropped up to its newline, and reading resumes at the next line: that is the
 * "resync at a newline" rule in docs/interfaces.md. Invalid UTF-8 is `malformed`. Blank lines are skipped.
 */
export class LineReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private discarding = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  /** `text` is the line as read (UTF-8 decoded), when there is one: a lift port parses it again with its own parser. */
  constructor(private readonly onResult: (result: SerialParseResult, text?: string) => void) {}

  push(data: Buffer): void {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      if (newline === -1) {
        this.append(data.subarray(start));
        return;
      }
      this.finish(data.subarray(start, newline + 1));
      start = newline + 1;
    }
  }

  /** Bytes held while waiting for a newline; never more than SERIAL_MAX_LINE_BYTES - 1. */
  get buffered(): number {
    return this.length;
  }

  private append(part: Buffer): void {
    if (this.discarding || part.length === 0) return;
    // Without its newline, a line may hold at most SERIAL_MAX_LINE_BYTES - 1 bytes.
    if (this.length + part.length > SERIAL_MAX_LINE_BYTES - 1) {
      this.reset();
      this.discarding = true;
      this.onResult({ ok: false, problem: "oversize", detail: `Longer than ${SERIAL_MAX_LINE_BYTES} bytes.` });
      return;
    }
    this.chunks.push(Buffer.from(part));
    this.length += part.length;
  }

  private finish(lastPart: Buffer): void {
    if (this.discarding) {
      this.discarding = false;
      return;
    }
    if (this.length + lastPart.length > SERIAL_MAX_LINE_BYTES) {
      this.reset();
      this.onResult({ ok: false, problem: "oversize", detail: `Longer than ${SERIAL_MAX_LINE_BYTES} bytes.` });
      return;
    }
    const bytes = Buffer.concat([...this.chunks, lastPart]);
    this.reset();
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      this.onResult({ ok: false, problem: "malformed", detail: "Not UTF-8." });
      return;
    }
    if (text.trim() === "") return;
    this.onResult(parseSerialLine(text), text);
  }

  private reset(): void {
    this.chunks = [];
    this.length = 0;
  }
}
