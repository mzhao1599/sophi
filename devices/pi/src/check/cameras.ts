import { NOT_A_PI, commandProblem, isLinux, pass, skip, text, warn, type Check, type CheckContext, type CheckLine } from "./core";

/**
 * The cameras: `v4l2-ctl --list-devices` for the USB video devices, then `--list-formats-ext` on each of their
 * /dev/video nodes (only enumerates; nothing streams, nothing is recorded). The walker has three InnoMaker UVC
 * cameras (one 720p, two 1080p, by the order summary), each advertised with MJPEG and YUY2.
 */
export const EXPECTED_CAMERAS = 3;
/** Formats the cameras are expected to offer: MJPEG (compressed) and YUY2 (v4l2 calls it YUYV). */
const WANTED_FORMATS = ["MJPG", "YUYV"];

export interface VideoDevice {
  name: string;
  /** The bus in brackets: `usb-xhci-hcd.0-1.2` for a USB camera, `platform:...` for the Pi's own blocks. */
  bus: string;
  nodes: string[];
}

/** `v4l2-ctl --list-devices`: a `Name (bus):` line, then its device files indented below it. */
export function parseListDevices(output: string): VideoDevice[] {
  const devices: VideoDevice[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      const match = /^(.*) \(([^()]*)\):\s*$/.exec(line);
      devices.push({ name: (match?.[1] ?? line.replace(/:\s*$/, "")).trim(), bus: match?.[2] ?? "", nodes: [] });
    } else if (devices.length) devices.at(-1)!.nodes.push(line.trim());
  }
  return devices;
}

export interface VideoFormat {
  fourcc: string;
  /** Each size with its highest frame rate (null when the camera gave none). */
  sizes: Array<{ size: string; fps: number | null }>;
}

/** `v4l2-ctl -d <node> --list-formats-ext`: the Video Capture formats only (a UVC metadata node has none). */
export function parseFormats(output: string): VideoFormat[] {
  const formats: VideoFormat[] = [];
  let capture = true;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const type = /^Type: (.*)$/.exec(line);
    if (type) {
      capture = type[1] === "Video Capture" || type[1] === "Video Capture Multiplanar";
      continue;
    }
    if (!capture) continue;
    const format = /^\[\d+\]: '([^']+)'/.exec(line);
    if (format) {
      formats.push({ fourcc: format[1]!.trim(), sizes: [] });
      continue;
    }
    const size = /^Size: \w+ (\d+x\d+)/.exec(line);
    if (size && formats.length) {
      formats.at(-1)!.sizes.push({ size: size[1]!, fps: null });
      continue;
    }
    const fps = /\(([\d.]+) fps\)/.exec(line);
    const current = formats.at(-1)?.sizes.at(-1);
    if (fps && current) current.fps = Math.max(current.fps ?? 0, Math.round(Number(fps[1])));
  }
  return formats;
}

function describeFormats(formats: VideoFormat[]): string {
  return formats
    .map((f) => {
      const sizes = f.sizes.slice(0, 4).map((s) => `${s.size}${s.fps === null ? "" : `@${s.fps}`}`);
      return `${f.fourcc} ${sizes.join(" ")}${f.sizes.length > 4 ? ` (+${f.sizes.length - 4} more)` : ""}`;
    })
    .join("; ");
}

export async function cameraLines(ctx: CheckContext): Promise<CheckLine[]> {
  if (!isLinux(ctx)) return [skip("camera", "cameras", NOT_A_PI(ctx))];
  const list = await ctx.run("v4l2-ctl", ["--list-devices"]);
  if (list.missing) return [skip("camera", "cameras", "v4l2-ctl is not installed: sudo apt install v4l-utils, then run this again")];
  const output = text(list);
  // With no video device at all, v4l2-ctl says it can't open /dev/video0 and exits 1.
  const problem = commandProblem("v4l2-ctl", list);
  if (problem && !/Cannot open device/i.test(`${output}${list.stderr}`)) return [warn("camera", "cameras", problem)];
  const usb = parseListDevices(output).filter((d) => d.bus.startsWith("usb-"));
  const lines: CheckLine[] = [];
  for (const [i, camera] of usb.entries()) {
    const item = `camera ${i + 1}`;
    let found: { node: string; formats: VideoFormat[] } | null = null;
    const problems: string[] = [];
    for (const node of camera.nodes.filter((n) => n.startsWith("/dev/video"))) {
      const result = await ctx.run("v4l2-ctl", ["-d", node, "--list-formats-ext"]);
      const why = commandProblem("v4l2-ctl", result);
      if (why) {
        problems.push(`${node}: ${why}`);
        continue;
      }
      const formats = parseFormats(text(result));
      if (formats.length) {
        found = { node, formats };
        break;
      }
    }
    const where = `"${camera.name}" on ${camera.bus}`;
    if (!found) {
      lines.push(warn("camera", item, `${where}: no capture formats listed${problems.length ? ` (${problems.join("; ")})` : ""}`));
      continue;
    }
    const detail = `${where}, ${found.node}: ${describeFormats(found.formats)}`;
    const missing = WANTED_FORMATS.filter((w) => !found.formats.some((f) => f.fourcc === w));
    lines.push(missing.length === WANTED_FORMATS.length ? warn("camera", item, `${detail}: neither MJPG nor YUYV`) : pass("camera", item, detail));
  }
  const count = `${usb.length} USB camera${usb.length === 1 ? "" : "s"}`;
  const head =
    usb.length === EXPECTED_CAMERAS
      ? pass("camera", "count", count)
      : warn("camera", "count", `${count}; expected ${EXPECTED_CAMERAS} (one 720p and two 1080p InnoMaker). Check each USB cable and hub port (lsusb)`);
  return [head, ...lines];
}

/** Two nodes per camera, 5 s each at most, plus the list. */
export const cameraCheck: Check = { name: "camera", timeoutMs: 40_000, run: cameraLines };
