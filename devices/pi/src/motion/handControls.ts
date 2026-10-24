import type { ModuleManager } from "../serial/modules";

/**
 * Whether a hand control that can stop motion is connected now: a handle module that declared a button and
 * is reachable (`ok` or `degraded`; `unavailable` means its heartbeats stopped or its port closed), or the
 * Pi's own GPIO buttons while gpiomon is watching them. The Pi can't sense a GPIO button's wire, so a watched
 * GPIO line counts; that is what the installer declared with WALKER_GPIO_BUTTONS=wired.
 */
export function handControlsConnected(
  modules: Pick<ModuleManager, "modules">,
  gpio: { status(): { health: "ok" | "unavailable" } } | null,
): boolean {
  const handle = modules
    .modules()
    .some((m) => m.type === "hand" && m.health !== "unavailable" && m.capabilities.some((c) => c.startsWith("button.")));
  return handle || gpio?.status().health === "ok";
}
