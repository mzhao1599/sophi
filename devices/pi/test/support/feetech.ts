import type { FeetechPort } from "../../src/motion/feetech/port";

/**
 * A FeetechPort whose replies are scripted: each write takes the next queued reply (or none). With `hold`, the
 * reply waits until `release()` so a test can see what happens while a transaction is open.
 */
export class ScriptedPort implements FeetechPort {
  readonly writes: Uint8Array[] = [];
  readonly replies: Array<Uint8Array | null> = [];
  hold = false;
  private held: Uint8Array[] = [];
  private readonly handlers = new Set<(chunk: Uint8Array) => void>();
  private readonly closeHandlers: Array<(reason: string) => void> = [];

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(Uint8Array.from(bytes));
    const reply = this.replies.shift();
    if (!reply || reply.length === 0) return;
    if (this.hold) this.held.push(reply);
    else this.emit(reply);
  }

  release(): void {
    const all = this.held;
    this.held = [];
    for (const reply of all) this.emit(reply);
  }

  emit(bytes: Uint8Array): void {
    setImmediate(() => {
      for (const fn of this.handlers) fn(bytes);
    });
  }

  onData(fn: (chunk: Uint8Array) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  onClose(fn: (reason: string) => void): void {
    this.closeHandlers.push(fn);
  }

  close(): void {
    for (const fn of this.closeHandlers) fn("closed");
  }
}
