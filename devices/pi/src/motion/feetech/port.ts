import { execFileSync } from "node:child_process";
import { closeSync, constants, createReadStream, openSync, write } from "node:fs";

/**
 * A byte pipe to one Feetech servo bus (one USB serial adapter, one arm). The bus class only needs this, so
 * tests and the simulator inject `FakeStsBus` (src/sim/fakeFeetech.ts) and the Pi injects a real tty.
 */
export interface FeetechPort {
  /** Resolves once every byte is handed to the OS; rejects if the port is closed or the write fails. */
  write(bytes: Uint8Array): Promise<void>;
  /** Returns a function that removes the listener. */
  onData(fn: (chunk: Uint8Array) => void): () => void;
  onClose(fn: (reason: string) => void): void;
  close(): void;
}

/** Feetech's factory default and LeRobot's default for STS3215 servos. */
export const FEETECH_DEFAULT_BAUD = 1_000_000;

/**
 * stty settings for a binary 8N1 link: raw (no line editing or CR/LF translation), no echo by the tty layer,
 * 8 data bits, no parity, one stop bit, no hardware flow control, ignore modem lines.
 */
export function feetechSttyArgs(path: string, baud = FEETECH_DEFAULT_BAUD, platform: NodeJS.Platform = process.platform): string[] {
  return [platform === "darwin" ? "-f" : "-F", path, String(baud), "raw", "-echo", "cs8", "-parenb", "-cstopb", "-crtscts", "clocal"];
}

/**
 * Opens a real adapter as a FeetechPort, the same way src/serial/port.ts opens the ESP32 ports (stty, then
 * plain file reads), so no native addon is needed. Not yet run against a servo bus; 1,000,000 baud is a
 * Linux termios speed, so on the Pi stty should accept it, which still needs checking on the device.
 */
export function openFeetechPort(path: string, baud = FEETECH_DEFAULT_BAUD): FeetechPort {
  execFileSync("stty", feetechSttyArgs(path, baud), { stdio: "ignore", timeout: 5000 });
  const fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
  const input = createReadStream("", { fd, autoClose: false, highWaterMark: 512 });
  const closeHandlers: Array<(reason: string) => void> = [];
  const dataHandlers = new Set<(chunk: Uint8Array) => void>();
  let closed = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    input.destroy();
    try {
      closeSync(fd);
    } catch {
      // Already gone (unplugged).
    }
    for (const handler of closeHandlers) handler(reason);
  };
  // Known limit, same pattern as src/serial/port.ts: reads block on a libuv thread-pool thread, and closing the
  // fd doesn't wake a read already blocked on a tty, so after close() that thread can stay stuck until a byte
  // arrives or the process exits. Reopening the same adapter works (a new fd), but each close-and-reopen without
  // traffic can hold one more pool thread; the systemd unit's UV_THREADPOOL_SIZE has to cover that.
  input.on("data", (data) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    for (const handler of dataHandlers) handler(chunk);
  });
  input.on("error", (error) => finish((error as NodeJS.ErrnoException).code ?? "read error"));
  input.on("end", () => finish("end of stream"));
  const writeAll = (buffer: Buffer, offset: number): Promise<void> =>
    new Promise((resolve, reject) => {
      write(fd, buffer, offset, buffer.length - offset, null, (error, written) => {
        if (error) return reject(error);
        if (offset + written < buffer.length) return writeAll(buffer, offset + written).then(resolve, reject);
        resolve();
      });
    });
  return {
    write(bytes) {
      if (closed) return Promise.reject(new Error("port closed"));
      return writeAll(Buffer.from(bytes), 0);
    },
    onData(fn) {
      dataHandlers.add(fn);
      return () => dataHandlers.delete(fn);
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    close() {
      finish("closed by the Pi");
    },
  };
}
