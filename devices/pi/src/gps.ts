import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readSync, statSync } from "node:fs";

export type GpsReading = { status: "fix"; latitude: number; longitude: number } | { status: "no_fix" };
export type GpsResult = GpsReading | { status: "no_rmc" };

function coordinate(value: string, direction: string, positive: string, negative: string, limit: number): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value) || (direction !== positive && direction !== negative)) return null;
  const number = Number(value);
  const degrees = Math.floor(number / 100);
  const minutes = number - degrees * 100;
  if (degrees > limit || minutes >= 60 || (degrees === limit && minutes > 0)) return null;
  return (degrees + minutes / 60) * (direction === negative ? -1 : 1);
}

/** Accept only checksum-verified NMEA RMC sentences; never infer a fix from an empty coordinate. */
export function parseRmc(line: string): GpsReading | null {
  const sentence = line.trim();
  const star = sentence.lastIndexOf("*");
  if (!sentence.startsWith("$") || star < 0 || !/^[0-9a-fA-F]{2}$/.test(sentence.slice(star + 1))) return null;
  const payload = sentence.slice(1, star);
  let checksum = 0;
  for (const character of payload) checksum ^= character.charCodeAt(0);
  if (checksum !== Number.parseInt(sentence.slice(star + 1), 16)) return null;
  const fields = payload.split(",");
  if (!/^[A-Z]{2}RMC$/.test(fields[0] ?? "")) return null;
  if (fields[2] === "V") return { status: "no_fix" };
  if (fields[2] !== "A") return null;
  const latitude = coordinate(fields[3] ?? "", fields[4] ?? "", "N", "S", 90);
  const longitude = coordinate(fields[5] ?? "", fields[6] ?? "", "E", "W", 180);
  return latitude === null || longitude === null ? { status: "no_fix" } : { status: "fix", latitude, longitude };
}

/** One local bring-up read. Coordinates go only to the invoking terminal, never to the walker cloud. */
export async function readGps(port: string, baud: number, waitMs: number): Promise<GpsResult> {
  if (!Number.isInteger(baud) || baud < 1200 || baud > 230400) throw new Error("GPS baud must be 1200–230400.");
  if (!Number.isInteger(waitMs) || waitMs < 1000 || waitMs > 180000) throw new Error("GPS wait must be 1–180 seconds.");
  if (!port.startsWith("/dev/") || !statSync(port).isCharacterDevice()) throw new Error("GPS port must be a /dev/ serial device.");
  execFileSync("stty", ["-F", port, String(baud), "raw", "-echo", "clocal", "-ixon", "-ixoff"], { stdio: "ignore", timeout: 5000 });
  // Nonblocking reads ensure the timeout can close a quiet receiver cleanly.
  const fd = openSync(port, constants.O_RDONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
  return new Promise<GpsResult>((resolve, reject) => {
    let pending = "";
    let sawNoFix = false;
    let settled = false;
    const buffer = Buffer.alloc(512);
    const finish = (result: GpsResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      closeSync(fd);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish({ status: sawNoFix ? "no_fix" : "no_rmc" }), waitMs);
    const poll = setInterval(() => {
      try {
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) return finish({ status: sawNoFix ? "no_fix" : "no_rmc" });
        pending += buffer.toString("ascii", 0, count);
        if (pending.length > 2048) pending = pending.slice(-512);
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          const reading = parseRmc(line);
          if (reading?.status === "fix") return finish(reading);
          if (reading?.status === "no_fix") sawNoFix = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") finish(error as Error);
      }
    }, 100);
  });
}
