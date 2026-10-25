import type { Bus } from "./bus";
import type { Logger } from "./log";

/**
 * Logs what the service does, from its events. On the Pi, reply text from the cloud is logged only by length:
 * it can repeat what the person said, and journald keeps logs far longer than the cloud's one hour. The Pi's
 * own fixed lines are logged in full. A caretaker's message read aloud (`message`) is logged by length too. The
 * simulator logs everything (its replies and messages are the fake cloud's).
 */
export function attachLogging(bus: Bus, log: Logger, options: { replyText: boolean }): void {
  bus.on("spoke", ({ text, kind }) =>
    log.info("speak", { kind, text: kind === "guidance" || ((kind === "reply" || kind === "message") && !options.replyText) ? `(${text.length} characters)` : text }),
  );
  bus.on("cue", ({ name }) => log.info("cue sound", { name }));
  bus.on("haptic", ({ instanceId, pattern, durationMs }) => log.info("haptic sent", { module: instanceId, pattern, ms: durationMs }));
  bus.on("button", ({ button, edge, source, detail }) => log.info("button", { button, edge, source, detail }));
  bus.on("talk", ({ state }) => log.info("talk state", { state }));
  bus.on("link", ({ state }) => log.info("link state", { state }));
  bus.on("config", ({ version }) => log.info("configuration version", { version }));
  bus.on("module", ({ instanceId, health }) => log.info("module health", { module: instanceId, health }));
  bus.on("turn", ({ outcome }) => log.info("turn", { outcome }));
}
