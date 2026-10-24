import {
  WalkerStatusViewSchema,
  isOpenProposal,
  zoneViews,
  type PartView,
  type ProposalView,
  type WalkerConfiguration,
  type WalkerEventView,
  type WalkerStatusView,
  type WalkerTurnView,
} from "@walker/contracts";
import { isOnline } from "./rules";
import type { DeviceRecord } from "./store";

export interface StatusInput {
  device: DeviceRecord;
  configuration: WalkerConfiguration;
  /** The open proposal, read after expiring proposals. */
  proposal: ProposalView | undefined;
  turns: WalkerTurnView[];
  lines: WalkerEventView[];
  now: Date;
}

const MAX_PARTS = 32;

/**
 * The walker's status view, built only from stored data with the contract's helpers. Parsing it with
 * WalkerStatusViewSchema makes the offline rules (no available part, no measured zone, no open
 * proposal) a check on every view, not a promise; a view that fails throws instead of reaching the page.
 */
export function buildStatusView({ device, configuration, proposal, turns, lines, now }: StatusInput): WalkerStatusView {
  const online = isOnline(device.last_heartbeat_at, now);
  const manifest = device.manifest;
  const receivedAt = device.snapshot_received_at ? Date.parse(device.snapshot_received_at) : Number.NaN;
  return WalkerStatusViewSchema.parse({
    device_id: device.device_id,
    name: device.name,
    online,
    last_seen_at: device.last_heartbeat_at,
    simulator: manifest?.simulator ?? false,
    configuration,
    applied_configuration_version: manifest?.device_configuration_version ?? null,
    parts: partViews(device, configuration, online),
    zones: zoneViews(device.snapshot, manifest, receivedAt, now.getTime(), online),
    open_proposal: online && proposal && isOpenProposal(proposal, now) ? proposal : null,
    turns,
    walker_said: lines,
  });
}

/**
 * Configured parts first, in configuration order, each with every instance the walker reports (or one
 * `unavailable` row with no instance when it reports none); then reported parts outside the
 * configuration. Each keeps its own `simulated` flag, because a simulator can have real parts plugged in.
 */
export function partViews(device: DeviceRecord, configuration: WalkerConfiguration, online: boolean): PartView[] {
  const reported = device.manifest?.modules ?? [];
  const selected = configuration.selected_module_ids;
  const view = (m: (typeof reported)[number]): PartView => ({
    module_id: m.module_id,
    instance_id: m.instance_id,
    health: online ? m.health : "unavailable",
    simulated: m.simulated,
    in_configuration: selected.includes(m.module_id),
  });
  const configured = selected.flatMap((moduleId): PartView[] => {
    const instances = reported.filter((m) => m.module_id === moduleId);
    if (instances.length > 0) return instances.map(view);
    return [{ module_id: moduleId, instance_id: null, health: "unavailable", simulated: false, in_configuration: true }];
  });
  const extra = reported.filter((m) => !selected.includes(m.module_id)).map(view);
  return [...configured, ...extra].slice(0, MAX_PARTS);
}
