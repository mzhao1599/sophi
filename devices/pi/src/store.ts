import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_EVENT_AGE_MS,
  MAX_QUEUED_EVENTS,
  WalkerConfigurationSchema,
  type WalkerConfiguration,
  type WalkerEvent,
} from "@walker/contracts";
import { z } from "zod";
import { checkServerUrl } from "./cloud/client";
import type { Logger } from "./log";

/** A line the walker said on its own, kept until a heartbeat delivers it. `saidMono` is monotonic time. */
export interface QueuedEvent {
  event_id: string;
  kind: WalkerEvent["kind"];
  text: string;
  saidMono: number;
}

export const CredentialFileSchema = z.object({
  /** https, or http to this machine only (the simulator's fake cloud): the same rule the client enforces. */
  server_url: z.url().refine((url) => {
    try {
      checkServerUrl(url);
      return true;
    } catch {
      return false;
    }
  }, "The server must use https."),
  device_id: z.uuid(),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type CredentialFile = z.infer<typeof CredentialFileSchema>;

/**
 * What the Pi keeps between restarts, in one folder (0700): the device credential (0600, never logged) and
 * the last confirmed configuration, so obstacle cues follow the user's choice even when offline after a
 * reboot. Status events (the Pi's own spoken lines, for the page) wait in a bounded in-memory queue. Voice
 * clips and confirmations are never stored here or anywhere else on disk.
 */
export class StateStore {
  private events: QueuedEvent[] = [];

  constructor(
    readonly dir: string,
    private readonly log: Logger,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  private path(name: string) {
    return join(this.dir, name);
  }

  readCredential(): CredentialFile | null {
    const file = this.path("credential.json");
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.log.error("the credential file can't be read; the walker counts as unpaired", { code });
      return null;
    }
    try {
      if ((statSync(file).mode & 0o077) !== 0) {
        chmodSync(file, 0o600);
        this.log.warn("credential file was readable by others; set it back to 0600");
      }
    } catch {
      // A failed permission check doesn't stop the walker; the file is still only read here.
    }
    const parsed = CredentialFileSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      this.log.error("credential file is unreadable; pair the walker again");
      return null;
    }
    return parsed.data;
  }

  writeCredential(credential: CredentialFile): void {
    this.writeAtomic("credential.json", JSON.stringify(CredentialFileSchema.parse(credential)), 0o600);
  }

  readConfiguration(): WalkerConfiguration | null {
    let raw: string;
    try {
      raw = readFileSync(this.path("configuration.json"), "utf8");
    } catch {
      return null;
    }
    const parsed = WalkerConfigurationSchema.safeParse(safeJson(raw));
    return parsed.success ? parsed.data : null;
  }

  writeConfiguration(configuration: WalkerConfiguration): void {
    this.writeAtomic("configuration.json", JSON.stringify(WalkerConfigurationSchema.parse(configuration)), 0o600);
  }

  /** Adds a line; past MAX_QUEUED_EVENTS the oldest is dropped. */
  pushEvent(event: QueuedEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_QUEUED_EVENTS) this.events.splice(0, this.events.length - MAX_QUEUED_EVENTS);
  }

  /**
   * The lines to send now, each with `ago_ms` measured on the monotonic clock (never by subtracting wall
   * times: a Pi has no battery clock and its date jumps at the boot-time sync). Lines older than
   * MAX_EVENT_AGE_MS are dropped for good.
   */
  pendingEvents(nowMono: number): WalkerEvent[] {
    this.events = this.events.filter((event) => nowMono - event.saidMono <= MAX_EVENT_AGE_MS);
    return this.events.map((event) => ({
      event_id: event.event_id,
      kind: event.kind,
      text: event.text,
      ago_ms: Math.min(MAX_EVENT_AGE_MS, Math.max(0, Math.round(nowMono - event.saidMono))),
    }));
  }

  /** Removes the events a successful heartbeat delivered. */
  acknowledgeEvents(ids: readonly string[]): void {
    const sent = new Set(ids);
    this.events = this.events.filter((event) => !sent.has(event.event_id));
  }

  private writeAtomic(name: string, contents: string, mode: number): void {
    const target = this.path(name);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, contents, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
