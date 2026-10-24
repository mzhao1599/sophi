import type { Pool, PoolClient } from "pg";
import type { ProposalView, WalkerConfiguration, WalkerEventView, WalkerTurnView } from "@walker/contracts";
import { OFFLINE_AFTER_MS } from "@walker/contracts";
import { WALKER_MIGRATIONS } from "./migrations";
import { decideAnswer, type Answer } from "./rules";
import type { AnswerResult, ClaimResult, DeviceRecord, Heartbeat, PairingClaim, PairingCode, SavedTurn, WalkerStore } from "./store";

/**
 * Walkers in Postgres through node-postgres (`pg`), on Render Postgres in production. The server is
 * the only client, so every query names the device id it was given (found by credential hash or by id
 * plus owner hash) or the owner hash itself. Steps that must be atomic run in one transaction that
 * first locks the device's row, so two requests for one walker take turns: of two Confirms at once,
 * the second sees the first's result.
 */

/** Any fixed number: the key both instances take before migrating. */
const MIGRATION_LOCK = 42_001;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresStoreError extends Error {
  override readonly name = "PostgresStoreError";
  constructor(
    action: string,
    readonly code: string | undefined,
  ) {
    // Postgres messages can quote row data, so only the action and the error code are kept.
    super(`Couldn't ${action} (database error ${code ?? "unknown"}).`);
  }
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export class PostgresWalkerStore implements WalkerStore {
  private migrated: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  ready(): Promise<void> {
    // One attempt at a time; a failed one is forgotten so the next request tries again.
    this.migrated ??= this.migrate().catch((error) => {
      this.migrated = null;
      throw error;
    });
    return this.migrated;
  }

  async ping() {
    await this.query("reach the database", "select 1", []);
  }

  private async migrate() {
    await this.transaction("run migrations", async (db) => {
      await db.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await db.query("create table if not exists walker_schema_migrations (id text primary key, applied_at timestamptz not null default now())");
      const { rows } = await db.query<{ id: string }>("select id from walker_schema_migrations");
      const applied = new Set(rows.map((r) => r.id));
      for (const migration of WALKER_MIGRATIONS) {
        if (applied.has(migration.id)) continue;
        await db.query(migration.sql);
        await db.query("insert into walker_schema_migrations (id) values ($1)", [migration.id]);
      }
    });
  }

  async putPairingCode(code: PairingCode, now: Date) {
    return this.transaction("save a pairing code", async (db) => {
      await db.query("delete from walker_pairing_codes where code = $1 and expires_at <= $2", [code.code, now]);
      await db.query("delete from walker_pairing_codes where owner_hash = $1", [code.owner_hash]);
      const { rowCount } = await db.query(
        "insert into walker_pairing_codes (code, owner_hash, created_at, expires_at) values ($1, $2, $3, $4) on conflict (code) do nothing",
        [code.code, code.owner_hash, code.created_at, code.expires_at],
      );
      return rowCount === 1;
    });
  }

  async countDevices(ownerHash: string) {
    const { rows } = await this.query<{ n: number }>("count walkers", "select count(*)::int as n from walker_devices where owner_hash = $1", [ownerHash]);
    return rows[0]?.n ?? 0;
  }

  async claimPairingCode({ code, now, device, configuration, maxDevices, address_key, triesSince, maxWrong }: PairingClaim): Promise<ClaimResult> {
    return this.transaction("pair a walker", async (db) => {
      // One attempt per address at a time: the count, the claim and the record of a wrong try can't
      // interleave. A second one answers at once instead of holding a pooled connection while it waits.
      const { rows: lock } = await db.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext('pair:' || $1)) as ok", [address_key]);
      if (!lock[0]?.ok) return { ok: false, reason: "busy" } as const;
      const { rows: tries } = await db.query<{ n: number }>(
        "select count(*)::int as n from walker_pairing_tries where address_key = $1 and at > $2",
        [address_key, triesSince],
      );
      if ((tries[0]?.n ?? 0) >= maxWrong) return { ok: false, reason: "locked" } as const;
      const { rows } = await db.query<{ owner_hash: string }>(
        "select owner_hash from walker_pairing_codes where code = $1 and expires_at > $2 for update",
        [code, now],
      );
      const owner = rows[0]?.owner_hash;
      if (!owner) {
        await db.query("insert into walker_pairing_tries (address_key, at) values ($1, $2)", [address_key, now]);
        return { ok: false, reason: "code_invalid" } as const;
      }
      // Serialises pairings for one owner, so two at once can't both pass the limit.
      await db.query("select pg_advisory_xact_lock(hashtext('owner:' || $1))", [owner]);
      const { rows: count } = await db.query<{ n: number }>("select count(*)::int as n from walker_devices where owner_hash = $1", [owner]);
      if ((count[0]?.n ?? 0) >= maxDevices) return { ok: false, reason: "walker_limit" } as const;
      await db.query("delete from walker_pairing_codes where code = $1", [code]);
      await db.query(
        "insert into walker_devices (id, owner_hash, credential_hash, name, service_version, created_at) values ($1, $2, $3, $4, $5, $6)",
        [device.device_id, owner, device.credential_hash, device.name, device.service_version, device.created_at],
      );
      await insertConfiguration(db, device.device_id, configuration);
      const record: DeviceRecord = {
        device_id: device.device_id,
        owner_hash: owner,
        name: device.name,
        service_version: device.service_version,
        created_at: device.created_at,
        last_heartbeat_at: null,
        manifest: null,
        snapshot: null,
        snapshot_received_at: null,
      };
      return { ok: true, device: record, configuration } as const;
    });
  }

  async deviceByCredential(credentialHash: string) {
    const { rows } = await this.query<DeviceRow>("find a walker", `select ${DEVICE_COLUMNS} from walker_devices where credential_hash = $1`, [credentialHash]);
    return rows[0] && toDevice(rows[0]);
  }

  async deviceForOwner(deviceId: string, ownerHash: string) {
    if (!UUID.test(deviceId)) return undefined;
    const { rows } = await this.query<DeviceRow>(
      "find a walker",
      `select ${DEVICE_COLUMNS} from walker_devices where id = $1 and owner_hash = $2`,
      [deviceId, ownerHash],
    );
    return rows[0] && toDevice(rows[0]);
  }

  async devicesForOwner(ownerHash: string) {
    const { rows } = await this.query<DeviceRow>(
      "list walkers",
      `select ${DEVICE_COLUMNS} from walker_devices where owner_hash = $1 order by created_at, id`,
      [ownerHash],
    );
    return rows.map(toDevice);
  }

  async recordHeartbeat(deviceId: string, heartbeat: Heartbeat) {
    await this.transaction("record a heartbeat", async (db) => {
      await db.query(
        `update walker_devices set last_heartbeat_at = $2, service_version = $3, manifest = $4, snapshot = $5, snapshot_received_at = $6 where id = $1`,
        [
          deviceId,
          heartbeat.at,
          heartbeat.service_version,
          JSON.stringify(heartbeat.manifest),
          heartbeat.snapshot && JSON.stringify(heartbeat.snapshot),
          heartbeat.snapshot ? heartbeat.at : null,
        ],
      );
      if (heartbeat.events.length > 0) {
        await db.query(
          `insert into walker_lines (device_id, event_id, kind, text, at)
           select $1, e.event_id, e.kind, e.text, e.at
           from rows from (jsonb_to_recordset($2::jsonb) as (event_id uuid, kind text, text text, at timestamptz)) with ordinality as e(event_id, kind, text, at, n)
           order by e.n
           on conflict (device_id, event_id) do nothing`,
          [deviceId, JSON.stringify(heartbeat.events)],
        );
      }
    });
  }

  async currentConfiguration(deviceId: string) {
    const { rows } = await this.query<ConfigurationRow>(
      "read a configuration",
      "select version, catalog_version, selected_module_ids, cues, created_at from walker_configurations where device_id = $1 order by version desc limit 1",
      [deviceId],
    );
    if (!rows[0]) throw new Error("A walker has no configuration.");
    return toConfiguration(rows[0]);
  }

  async expireProposals(deviceId: string, now: Date) {
    try {
      await expireIn(this.pool, deviceId, now);
    } catch (error) {
      throw new PostgresStoreError("expire proposals", pgCode(error));
    }
  }

  async openProposal(deviceId: string) {
    const { rows } = await this.query<ProposalRow>(
      "read the open proposal",
      `select ${PROPOSAL_COLUMNS} from walker_proposals where device_id = $1 and state = 'open'`,
      [deviceId],
    );
    return rows[0] && toProposal(rows[0]);
  }

  async recentTurns(deviceId: string, limit: number) {
    const { rows } = await this.query<TurnRow>(
      "read turns",
      `select * from (select ${TURN_COLUMNS}, seq from walker_turns where device_id = $1 order by created_at desc, seq desc limit $2) t order by created_at, seq`,
      [deviceId, limit],
    );
    return rows.map(toTurn);
  }

  async recentLines(deviceId: string, limit: number) {
    const { rows } = await this.query<LineRow>(
      "read walker lines",
      `select * from (select event_id, kind, text, at, seq from walker_lines where device_id = $1 order by at desc, seq desc limit $2) l order by at, seq`,
      [deviceId, limit],
    );
    return rows.map((r): WalkerEventView => ({ event_id: r.event_id, kind: r.kind, text: r.text, at: r.at.toISOString() }));
  }

  async answerProposal(deviceId: string, proposalId: string, answer: Answer, now: Date): Promise<AnswerResult> {
    if (!UUID.test(proposalId)) return { outcome: "not_found" };
    return this.transaction("answer a proposal", async (db) => {
      const { rows: device } = await db.query<{ last_heartbeat_at: Date | null }>(
        "select last_heartbeat_at from walker_devices where id = $1 for update",
        [deviceId],
      );
      const { rows } = await db.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from walker_proposals where id = $1 and device_id = $2`, [proposalId, deviceId]);
      if (!device[0] || !rows[0]) return { outcome: "not_found" } as const;
      const proposal = toProposal(rows[0]);
      const decision = decideAnswer(proposal, answer, await currentIn(db, deviceId), iso(device[0].last_heartbeat_at), now);
      if (decision.proposal.state !== proposal.state) {
        await db.query("update walker_proposals set state = $2, configuration_version = $3 where id = $1", [
          proposalId,
          decision.proposal.state,
          decision.proposal.configuration_version,
        ]);
      }
      if (decision.configuration) await insertConfiguration(db, deviceId, decision.configuration);
      return { outcome: decision.answered ? "answered" : "closed", proposal: decision.proposal } as const;
    });
  }

  async findTurn(deviceId: string, clientTurnId: string) {
    if (!UUID.test(clientTurnId)) return undefined;
    try {
      return await turnIn(this.pool, deviceId, clientTurnId);
    } catch (error) {
      throw new PostgresStoreError("read a turn", pgCode(error));
    }
  }

  async saveTurn(deviceId: string, turn: WalkerTurnView, proposal: ProposalView | null, now: Date): Promise<SavedTurn | null> {
    return this.transaction("save a turn", async (db) => {
      const { rowCount } = await db.query("select 1 from walker_devices where id = $1 for update", [deviceId]);
      if (rowCount === 0) return null;
      const prior = await turnIn(db, deviceId, turn.client_turn_id);
      if (prior) return { ...prior, created: false };
      if (proposal) {
        await expireIn(db, deviceId, now);
        await db.query("update walker_proposals set state = 'superseded' where device_id = $1 and state = 'open'", [deviceId]);
        await db.query(
          `insert into walker_proposals (id, device_id, client_turn_id, kind, from_cues, cues, base_configuration_version, summary, state, created_at, expires_at, configuration_version)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            proposal.proposal_id,
            deviceId,
            proposal.client_turn_id,
            proposal.kind,
            JSON.stringify(proposal.from_cues),
            JSON.stringify(proposal.cues),
            proposal.base_configuration_version,
            proposal.summary,
            proposal.state,
            proposal.created_at,
            proposal.expires_at,
            proposal.configuration_version,
          ],
        );
      }
      await db.query(
        `insert into walker_turns (id, device_id, client_turn_id, source, heard, heard_by, reply, answered_by, voiced_by, proposal_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [turn.turn_id, deviceId, turn.client_turn_id, turn.source, turn.heard, turn.heard_by, turn.reply, turn.answered_by, turn.voiced_by, proposal?.proposal_id ?? null, turn.created_at],
      );
      return { turn, proposal, created: true };
    });
  }

  async sweep(now: Date, historySince: Date, triesSince: Date) {
    await this.transaction("delete old history", async (db) => {
      await db.query("delete from walker_turns where created_at < $1", [historySince]);
      await db.query("delete from walker_lines where at < $1", [historySince]);
      await db.query("delete from walker_proposals where state <> 'open' and created_at < $1", [historySince]);
      await db.query("delete from walker_pairing_codes where expires_at <= $1", [now]);
      await db.query("delete from walker_pairing_tries where at <= $1", [triesSince]);
    });
  }

  async forget(deviceId: string, ownerHash: string) {
    if (!UUID.test(deviceId)) return false;
    // One statement, so one transaction: the cascade takes its configurations, proposals, turns and lines with it.
    const { rowCount } = await this.query("forget a walker", "delete from walker_devices where id = $1 and owner_hash = $2", [deviceId, ownerHash]);
    return rowCount === 1;
  }

  private async query<R extends object = object>(action: string, sql: string, values: unknown[]) {
    try {
      return await this.pool.query<R>(sql, values);
    } catch (error) {
      throw new PostgresStoreError(action, pgCode(error));
    }
  }

  private async transaction<T>(action: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    let db: PoolClient;
    try {
      db = await this.pool.connect();
    } catch (error) {
      throw new PostgresStoreError(action, pgCode(error));
    }
    try {
      await db.query("begin");
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error instanceof PostgresStoreError ? error : new PostgresStoreError(action, pgCode(error));
    } finally {
      db.release();
    }
  }
}

function pgCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function turnIn(db: Pool | PoolClient, deviceId: string, clientTurnId: string) {
  const { rows } = await db.query<TurnRow & { proposal_id: string | null }>(
    `select ${TURN_COLUMNS}, proposal_id from walker_turns where device_id = $1 and client_turn_id = $2`,
    [deviceId, clientTurnId],
  );
  if (!rows[0]) return undefined;
  const { rows: opened } = rows[0].proposal_id
    ? await db.query<ProposalRow>(`select ${PROPOSAL_COLUMNS} from walker_proposals where id = $1`, [rows[0].proposal_id])
    : { rows: [] };
  return { turn: toTurn(rows[0]), proposal: opened[0] ? toProposal(opened[0]) : null };
}

/** The same rule as rules.ts shouldExpire: past expiry, or no heartbeat within OFFLINE_AFTER_MS. */
async function expireIn(db: Pool | PoolClient, deviceId: string, now: Date) {
  await db.query(
    `update walker_proposals p set state = 'expired' from walker_devices d
     where p.device_id = $1 and d.id = p.device_id and p.state = 'open'
       and (p.expires_at <= $2 or d.last_heartbeat_at is null or d.last_heartbeat_at > $2 or d.last_heartbeat_at < $3)`,
    [deviceId, now, new Date(now.getTime() - OFFLINE_AFTER_MS)],
  );
}

async function currentIn(db: PoolClient, deviceId: string): Promise<WalkerConfiguration> {
  const { rows } = await db.query<ConfigurationRow>(
    "select version, catalog_version, selected_module_ids, cues, created_at from walker_configurations where device_id = $1 order by version desc limit 1",
    [deviceId],
  );
  if (!rows[0]) throw new Error("A walker has no configuration.");
  return toConfiguration(rows[0]);
}

async function insertConfiguration(db: PoolClient, deviceId: string, c: WalkerConfiguration) {
  await db.query(
    "insert into walker_configurations (device_id, version, catalog_version, selected_module_ids, cues, created_at) values ($1, $2, $3, $4, $5, $6)",
    [deviceId, c.version, c.catalog_version, JSON.stringify(c.selected_module_ids), JSON.stringify(c.cues), c.created_at],
  );
}

const DEVICE_COLUMNS = "id, owner_hash, name, service_version, created_at, last_heartbeat_at, manifest, snapshot, snapshot_received_at";
interface DeviceRow {
  id: string;
  owner_hash: string;
  name: string;
  service_version: string;
  created_at: Date;
  last_heartbeat_at: Date | null;
  manifest: DeviceRecord["manifest"];
  snapshot: DeviceRecord["snapshot"];
  snapshot_received_at: Date | null;
}
function toDevice(r: DeviceRow): DeviceRecord {
  return {
    device_id: r.id,
    owner_hash: r.owner_hash,
    name: r.name,
    service_version: r.service_version,
    created_at: r.created_at.toISOString(),
    last_heartbeat_at: iso(r.last_heartbeat_at),
    manifest: r.manifest,
    snapshot: r.snapshot,
    snapshot_received_at: iso(r.snapshot_received_at),
  };
}

interface ConfigurationRow {
  version: number;
  catalog_version: number;
  selected_module_ids: WalkerConfiguration["selected_module_ids"];
  cues: WalkerConfiguration["cues"];
  created_at: Date;
}
function toConfiguration(r: ConfigurationRow): WalkerConfiguration {
  return { version: r.version, catalog_version: r.catalog_version, selected_module_ids: r.selected_module_ids, cues: r.cues, created_at: r.created_at.toISOString() };
}

const PROPOSAL_COLUMNS =
  "id, client_turn_id, kind, from_cues, cues, base_configuration_version, summary, state, created_at, expires_at, configuration_version";
interface ProposalRow {
  id: string;
  client_turn_id: string;
  kind: "cues_change";
  from_cues: ProposalView["from_cues"];
  cues: ProposalView["cues"];
  base_configuration_version: number;
  summary: string;
  state: ProposalView["state"];
  created_at: Date;
  expires_at: Date;
  configuration_version: number | null;
}
function toProposal(r: ProposalRow): ProposalView {
  return {
    proposal_id: r.id,
    client_turn_id: r.client_turn_id,
    kind: r.kind,
    from_cues: r.from_cues,
    cues: r.cues,
    base_configuration_version: r.base_configuration_version,
    summary: r.summary,
    state: r.state,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    configuration_version: r.configuration_version,
  };
}

const TURN_COLUMNS = "id, client_turn_id, source, heard, heard_by, reply, answered_by, voiced_by, created_at";
interface TurnRow {
  id: string;
  client_turn_id: string;
  source: WalkerTurnView["source"];
  heard: string | null;
  heard_by: WalkerTurnView["heard_by"];
  reply: string;
  answered_by: WalkerTurnView["answered_by"];
  voiced_by: WalkerTurnView["voiced_by"];
  created_at: Date;
}
function toTurn(r: TurnRow): WalkerTurnView {
  return {
    turn_id: r.id,
    client_turn_id: r.client_turn_id,
    source: r.source,
    heard: r.heard,
    heard_by: r.heard_by,
    reply: r.reply,
    answered_by: r.answered_by,
    voiced_by: r.voiced_by,
    created_at: r.created_at.toISOString(),
  };
}

interface LineRow {
  event_id: string;
  kind: WalkerEventView["kind"];
  text: string;
  at: Date;
}
