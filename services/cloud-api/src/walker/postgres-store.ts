import type { Pool, PoolClient } from "pg";
import type { ProposalView, WalkerConfiguration, WalkerEventView, WalkerTurnView } from "@walker/contracts";
import { HELP_CLOSED_SHOWN_MS, HELP_OPEN_MAX_MS, HELP_RETENTION_MS, LOCATION_FIX_MAX_AGE_MS, MAX_CIRCLE_MEMBERS, OFFLINE_AFTER_MS } from "@walker/contracts";
import { WALKER_MIGRATIONS } from "./migrations";
import { keepIds } from "./store";
import { decideAnswer, type Answer } from "./rules";
import type {
  AnswerResult,
  CircleInviteRecord,
  CircleMemberRecord,
  CircleMessageRecord,
  ClaimResult,
  DeviceRecord,
  Heartbeat,
  HelpAnswer,
  HelpAnswerResult,
  HelpAsk,
  HelpAskResult,
  HelpPersonRecord,
  HelpRecord,
  InviteClaim,
  InviteClaimResult,
  PairingClaim,
  PairingCode,
  PutInviteResult,
  SavedTurn,
  WalkerStore,
} from "./store";

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
        location_sharing_enabled: false,
        location: null,
        location_received_at: null,
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
        `update walker_devices set last_heartbeat_at = $2, service_version = $3, manifest = $4, snapshot = $5, snapshot_received_at = $6,
           location = case when location_sharing_enabled and $7::jsonb is not null and $4::jsonb->>'simulator' = 'false' then $7::jsonb else location end,
           location_received_at = case when location_sharing_enabled and $7::jsonb is not null and $4::jsonb->>'simulator' = 'false' then $8::timestamptz else location_received_at end
         where id = $1`,
        [
          deviceId,
          heartbeat.at,
          heartbeat.service_version,
          JSON.stringify(heartbeat.manifest),
          heartbeat.snapshot && JSON.stringify(heartbeat.snapshot),
          heartbeat.snapshot ? heartbeat.at : null,
          heartbeat.location ? JSON.stringify({ latitude: heartbeat.location.latitude, longitude: heartbeat.location.longitude }) : null,
          heartbeat.location ? new Date(Date.parse(heartbeat.at) - heartbeat.location.age_ms).toISOString() : null,
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

  async setLocationSharing(deviceId: string, memberId: string, enabled: boolean) {
    const result = await this.query(
      "set location sharing",
      `update walker_devices set location_sharing_enabled = $3, location = null, location_received_at = null
       where id = $1 and exists (
         select 1 from walker_circle_members where id = $2 and device_id = $1 and role = 'walker_user' and state = 'member'
       )`,
      [deviceId, memberId, enabled],
    );
    return result.rowCount === 1;
  }

  async writeLocationSharing(deviceId: string, enabled: boolean) {
    if (!UUID.test(deviceId)) return false;
    const result = await this.query(
      "write location sharing",
      "update walker_devices set location_sharing_enabled = $2, location = null, location_received_at = null where id = $1",
      [deviceId, enabled],
    );
    return result.rowCount === 1;
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
      await db.query("update walker_devices set location = null, location_received_at = null where location_received_at < $1", [new Date(now.getTime() - LOCATION_FIX_MAX_AGE_MS)]);
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

  // ---- The two-phone circle. Steps that must be atomic lock the walker's row first. ----

  async putInvite(invite: CircleInviteRecord, { maxOpen, maxMembers }: { maxOpen: number; maxMembers: number }, now: Date): Promise<PutInviteResult> {
    return this.transaction("save an invite", async (db) => {
      const { rowCount } = await db.query("select 1 from walker_devices where id = $1 for update", [invite.device_id]);
      if (rowCount === 0) return "circle_full" as const;
      await db.query("delete from walker_circle_invites where expires_at <= $1", [now]);
      if (invite.role === "walker_user") {
        const { rowCount: taken } = await db.query("select 1 from walker_circle_members where device_id = $1 and role = 'walker_user'", [invite.device_id]);
        if (taken) return "walker_user_taken" as const;
        await db.query("delete from walker_circle_invites where device_id = $1 and role = 'walker_user'", [invite.device_id]);
      }
      const { rows } = await db.query<{ invites: number; members: number }>(
        `select (select count(*)::int from walker_circle_invites where device_id = $1) as invites,
                (select count(*)::int from walker_circle_members where device_id = $1 and (state = 'member' or expires_at > $2)) as members`,
        [invite.device_id, now],
      );
      if ((rows[0]?.invites ?? 0) >= maxOpen || (rows[0]?.members ?? 0) >= maxMembers) return "circle_full" as const;
      const { rowCount: saved } = await db.query(
        `insert into walker_circle_invites (id, device_id, code, name, role, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (code) do nothing`,
        [invite.invite_id, invite.device_id, invite.code, invite.name, invite.role, invite.created_at, invite.expires_at],
      );
      return saved === 1 ? ("ok" as const) : ("code_taken" as const);
    });
  }

  async circleOf(deviceId: string, now: Date) {
    const [members, invites] = await Promise.all([
      this.query<MemberRow>("read the circle", `select ${MEMBER_COLUMNS} from walker_circle_members where device_id = $1 order by created_at, id`, [deviceId]),
      this.query<InviteRow>(
        "read the circle",
        `select ${INVITE_COLUMNS} from walker_circle_invites where device_id = $1 and expires_at > $2 order by created_at, id`,
        [deviceId, now],
      ),
    ]);
    return { members: members.rows.map(toMember), invites: invites.rows.map(toInvite) };
  }

  async claimInvite({ code, now, member, waitingUntil, maxMembers, address_key, triesSince, maxWrong }: InviteClaim): Promise<InviteClaimResult> {
    return this.transaction("join a circle", async (db) => {
      const { rows: lock } = await db.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext('join:' || $1)) as ok", [address_key]);
      if (!lock[0]?.ok) return { ok: false, reason: "busy" } as const;
      const { rows: tries } = await db.query<{ n: number }>(
        "select count(*)::int as n from walker_pairing_tries where address_key = $1 and at > $2",
        [address_key, triesSince],
      );
      if ((tries[0]?.n ?? 0) >= maxWrong) return { ok: false, reason: "locked" } as const;
      const { rows } = await db.query<InviteRow>(`select ${INVITE_COLUMNS} from walker_circle_invites where code = $1 and expires_at > $2`, [code, now]);
      const invite = rows[0] && toInvite(rows[0]);
      if (!invite) {
        await db.query("insert into walker_pairing_tries (address_key, at) values ($1, $2)", [address_key, now]);
        return { ok: false, reason: "code_invalid" } as const;
      }
      // Serialises joins and invites for one walker, so two at once can't both pass the limits.
      await db.query("select 1 from walker_devices where id = $1 for update", [invite.device_id]);
      // Another join used it while this one waited for the lock.
      const { rowCount: still } = await db.query("select 1 from walker_circle_invites where id = $1", [invite.invite_id]);
      if (still !== 1) return { ok: false, reason: "code_invalid" } as const;
      const { rows: count } = await db.query<{ n: number; walker_user: boolean }>(
        `select count(*) filter (where state = 'member' or expires_at > $2)::int as n, bool_or(role = 'walker_user') as walker_user
         from walker_circle_members where device_id = $1`,
        [invite.device_id, now],
      );
      if ((count[0]?.n ?? 0) >= maxMembers) return { ok: false, reason: "circle_full" } as const;
      if (invite.role === "walker_user" && count[0]?.walker_user) return { ok: false, reason: "walker_user_taken" } as const;
      await db.query("delete from walker_circle_invites where id = $1", [invite.invite_id]);
      const waiting = invite.role === "caregiver";
      const record: CircleMemberRecord = {
        member_id: member.member_id,
        device_id: invite.device_id,
        name: invite.name,
        role: invite.role,
        state: waiting ? "waiting" : "member",
        created_at: member.created_at,
        expires_at: waiting ? waitingUntil : null,
        joined_at: waiting ? null : member.created_at,
      };
      await db.query(
        `insert into walker_circle_members (id, device_id, secret_hash, name, role, state, created_at, expires_at, joined_at, replaces_member_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          record.member_id,
          record.device_id,
          member.secret_hash,
          record.name,
          record.role,
          record.state,
          record.created_at,
          record.expires_at,
          record.joined_at,
          member.replaces_member_id,
        ],
      );
      return { ok: true, member: record } as const;
    });
  }

  async memberBySecret(secretHash: string) {
    const { rows } = await this.query<MemberRow>("find a phone", `select ${MEMBER_COLUMNS} from walker_circle_members where secret_hash = $1`, [secretHash]);
    return rows[0] && toMember(rows[0]);
  }

  async circleDevice(deviceId: string) {
    if (!UUID.test(deviceId)) return undefined;
    const { rows } = await this.query<DeviceRow>("find a walker", `select ${DEVICE_COLUMNS} from walker_devices where id = $1`, [deviceId]);
    return rows[0] && toDevice(rows[0]);
  }

  async approveJoin(deviceId: string, memberId: string, now: Date) {
    if (!UUID.test(memberId)) return undefined;
    return this.transaction("approve a join", async (db) => {
      const { rows } = await db.query<MemberRow & { replaces_member_id: string | null }>(
        `update walker_circle_members set state = 'member', expires_at = null, joined_at = $3
         where device_id = $1 and id = $2 and state = 'waiting' and expires_at > $3
         returning ${MEMBER_COLUMNS}, replaces_member_id`,
        [deviceId, memberId, now],
      );
      if (rows[0]) {
        // The same browser's earlier membership goes now that this one is in; the cascade takes its messages.
        if (rows[0].replaces_member_id) await db.query("delete from walker_circle_members where id = $1", [rows[0].replaces_member_id]);
        return toMember(rows[0]);
      }
      // Approved already (a retried Approve): the member as it is.
      const { rows: already } = await db.query<MemberRow>(
        `select ${MEMBER_COLUMNS} from walker_circle_members where device_id = $1 and id = $2 and state = 'member'`,
        [deviceId, memberId],
      );
      return already[0] && toMember(already[0]);
    });
  }

  async removeMember(deviceId: string, memberId: string) {
    if (!UUID.test(memberId)) return false;
    return this.transaction("remove a phone", async (db) => {
      const { rows } = await db.query<{ role: string }>("delete from walker_circle_members where device_id = $1 and id = $2 returning role", [deviceId, memberId]);
      if (rows[0]?.role === "walker_user") await db.query("update walker_devices set location_sharing_enabled = false, location = null, location_received_at = null where id = $1", [deviceId]);
      return rows.length === 1;
    });
  }

  async saveMessage(message: CircleMessageRecord, maxLive: number, now: Date) {
    return this.transaction("save a message", async (db) => {
      const { rowCount } = await db.query("select 1 from walker_devices where id = $1 for update", [message.device_id]);
      if (rowCount === 0) return null;
      const { rows: prior } = await db.query<MessageRow & { cleared: boolean }>(
        `select ${MESSAGE_COLUMNS}, cleared from walker_circle_messages where from_member_id = $1 and client_message_id = $2`,
        [message.from_member_id, message.client_message_id],
      );
      if (prior[0]?.cleared) return "cleared" as const;
      if (prior[0]) return { message: toMessage(prior[0]), created: false };
      const { rows: members } = await db.query<{ n: number }>(
        "select count(*)::int as n from walker_circle_members where device_id = $1 and state = 'member' and id = any($2::uuid[])",
        [message.device_id, [message.from_member_id, message.to_member_id]],
      );
      if ((members[0]?.n ?? 0) !== 2) return null;
      await db.query("delete from walker_circle_messages where device_id = $1 and expires_at <= $2", [message.device_id, now]);
      await db.query(
        `insert into walker_circle_messages (id, device_id, from_member_id, to_member_id, client_message_id, text, created_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [message.message_id, message.device_id, message.from_member_id, message.to_member_id, message.client_message_id, message.text, message.created_at, message.expires_at],
      );
      // Past the newest `maxLive`: the text goes now; the row stays until it expires so a retry isn't saved again.
      await db.query(
        `update walker_circle_messages set cleared = true, text = '' where device_id = $1 and not cleared and id not in (
           select id from walker_circle_messages where device_id = $1 and not cleared order by created_at desc, seq desc limit $2)`,
        [message.device_id, maxLive],
      );
      return { message: { ...message }, created: true };
    });
  }

  async messagesFor(deviceId: string, memberId: string, now: Date) {
    const { rows } = await this.query<MessageRow>(
      "read messages",
      `select ${MESSAGE_COLUMNS} from walker_circle_messages
       where device_id = $1 and (from_member_id = $2 or to_member_id = $2) and expires_at > $3 and not cleared order by created_at, seq`,
      [deviceId, memberId, now],
    );
    return rows.map(toMessage);
  }

  async sweepCircle(now: Date, lapsedBefore: Date) {
    // Three short statements, each its own transaction, so the sweep never holds row locks across tables
    // while a join or a message holds a walker's row (no lock-order deadlock).
    await this.query("delete old circle data", "delete from walker_circle_invites where expires_at <= $1", [now]);
    await this.query("delete old circle data", "delete from walker_circle_messages where expires_at <= $1", [now]);
    await this.query("delete old circle data", "delete from walker_circle_members where state = 'waiting' and expires_at < $1", [lapsedBefore]);
    await this.query("delete old location", "update walker_devices set location = null, location_received_at = null where location_received_at < $1", [new Date(now.getTime() - LOCATION_FIX_MAX_AGE_MS)]);
    await this.query("delete old help requests", "delete from walker_help_requests where created_at <= $1", [new Date(now.getTime() - HELP_RETENTION_MS)]);
    await this.query("expire help requests", EXPIRE_HELP, [null, now, HELP_OPEN_MAX_MS]);
  }

  // ---- Help requests. Each step locks the walker's row first, so steps for one walker take turns. ----

  async askForHelp(ask: HelpAsk, now: Date): Promise<HelpAskResult> {
    if (!UUID.test(ask.device_id)) return { outcome: "not_found" };
    return this.transaction("ask for help", async (db) => {
      const { rowCount } = await db.query("select 1 from walker_devices where id = $1 for update", [ask.device_id]);
      if (rowCount === 0) return { outcome: "not_found" } as const;
      await db.query(EXPIRE_HELP, [ask.device_id, now, HELP_OPEN_MAX_MS]);
      const members = await membersIn(db, ask.device_id);
      if (ask.asked_by_member_id !== null && !members.some((m) => m.id === ask.asked_by_member_id && m.role === "walker_user" && m.state === "member")) {
        return { outcome: "not_found" } as const;
      }
      const { rows: prior } = await db.query<HelpRow>(
        `select ${HELP_COLUMNS} from walker_help_requests where device_id = $1 and client_help_ids ? $2 limit 1`,
        [ask.device_id, ask.client_help_id],
      );
      if (prior[0]) return { outcome: "existing", help: toHelp(prior[0]) } as const;
      const { rows: open } = await db.query<HelpRow>(`select ${HELP_COLUMNS} from walker_help_requests where device_id = $1 and closed_at is null`, [ask.device_id]);
      if (open[0]) {
        const { rows } = await db.query<HelpRow>(
          `update walker_help_requests set client_help_ids = $2 where id = $1 returning ${HELP_COLUMNS}`,
          [open[0].id, JSON.stringify(keepIds(open[0].client_help_ids, ask.client_help_id))],
        );
        return { outcome: "existing", help: toHelp(rows[0]!) } as const;
      }
      const sentTo = members.filter((m) => m.role === "caregiver" && m.state === "member").map(person);
      if (sentTo.length === 0) return { outcome: "no_caretaker" } as const;
      const { rows } = await db.query<HelpRow>(
        `insert into walker_help_requests (id, device_id, client_help_ids, source, sent_to, created_at) values ($1, $2, $3, $4, $5, $6)
         returning ${HELP_COLUMNS}`,
        [ask.help_id, ask.device_id, JSON.stringify([ask.client_help_id]), ask.source, JSON.stringify(sentTo), ask.created_at],
      );
      return { outcome: "created", help: toHelp(rows[0]!) } as const;
    });
  }

  async answerHelp(deviceId: string, helpId: string, answer: HelpAnswer, now: Date): Promise<HelpAnswerResult> {
    if (!UUID.test(deviceId) || !UUID.test(helpId)) return { outcome: "not_found" };
    return this.transaction("answer a help request", async (db) => {
      await db.query("select 1 from walker_devices where id = $1 for update", [deviceId]);
      await db.query(EXPIRE_HELP, [deviceId, now, HELP_OPEN_MAX_MS]);
      const { rows: found } = await db.query<HelpRow>(`select ${HELP_COLUMNS} from walker_help_requests where device_id = $1 and id = $2`, [deviceId, helpId]);
      const help = found[0] && toHelp(found[0]);
      if (!help) return { outcome: "not_found" } as const;
      const members = (await membersIn(db, deviceId)).filter((m) => m.state === "member");
      const by = answer.member_id === null ? undefined : members.find((m) => m.id === answer.member_id);
      if (answer.member_id !== null && !by) return { outcome: "not_member" } as const;
      if (help.closed) return { outcome: "closed", help } as const;
      if (answer.kind === "coming") {
        if (!by || help.coming.some((c) => c.member_id === by.id) || help.coming.length >= MAX_CIRCLE_MEMBERS) return { outcome: "unchanged", help } as const;
        const { rows } = await db.query<HelpRow>(
          `update walker_help_requests set coming = coming || $3::jsonb where device_id = $1 and id = $2 returning ${HELP_COLUMNS}`,
          [deviceId, helpId, JSON.stringify([person(by)])],
        );
        return { outcome: "answered", help: toHelp(rows[0]!) } as const;
      }
      const closer = by ?? members.find((m) => m.role === "walker_user");
      const { rows } = await db.query<HelpRow>(
        `update walker_help_requests set closed_at = $3, closed_how = $4, closed_by = $5 where device_id = $1 and id = $2 returning ${HELP_COLUMNS}`,
        [deviceId, helpId, now, answer.how, closer ? JSON.stringify(person(closer)) : null],
      );
      return { outcome: "answered", help: toHelp(rows[0]!) } as const;
    });
  }

  async helpOf(deviceId: string, now: Date, shownTo: string | null = null): Promise<HelpRecord | null> {
    if (!UUID.test(deviceId)) return null;
    return this.transaction("read help requests", async (db) => {
      // Reads alone don't lock the walker; adding a phone to shown_to does, like every other write here.
      if (shownTo !== null) await db.query("select 1 from walker_devices where id = $1 for update", [deviceId]);
      await db.query(EXPIRE_HELP, [deviceId, now, HELP_OPEN_MAX_MS]);
      const { rows } = await db.query<HelpRow>(
        `select ${HELP_COLUMNS} from walker_help_requests where device_id = $1 and (closed_at is null or closed_at > $2)
         order by (closed_at is null) desc, closed_at desc, seq desc limit 1`,
        [deviceId, new Date(now.getTime() - HELP_CLOSED_SHOWN_MS)],
      );
      const help = rows[0] && toHelp(rows[0]);
      if (!help) return null;
      if (shownTo === null || !UUID.test(shownTo) || help.closed || help.shown_to.some((p) => p.member_id === shownTo) || help.shown_to.length >= MAX_CIRCLE_MEMBERS) return help;
      const viewer = (await membersIn(db, deviceId)).find((m) => m.id === shownTo && m.role === "caregiver" && m.state === "member");
      if (!viewer) return help;
      const { rows: updated } = await db.query<HelpRow>(
        `update walker_help_requests set shown_to = shown_to || $2::jsonb where id = $1 returning ${HELP_COLUMNS}`,
        [help.help_id, JSON.stringify([person(viewer)])],
      );
      return toHelp(updated[0]!);
    });
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

const DEVICE_COLUMNS = "id, owner_hash, name, service_version, created_at, last_heartbeat_at, manifest, snapshot, snapshot_received_at, location_sharing_enabled, location, location_received_at";
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
  location_sharing_enabled: boolean;
  location: DeviceRecord["location"];
  location_received_at: Date | null;
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
    location_sharing_enabled: r.location_sharing_enabled,
    location: r.location,
    location_received_at: iso(r.location_received_at),
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

const MEMBER_COLUMNS = "id, device_id, name, role, state, created_at, expires_at, joined_at";
interface MemberRow {
  id: string;
  device_id: string;
  name: string;
  role: CircleMemberRecord["role"];
  state: CircleMemberRecord["state"];
  created_at: Date;
  expires_at: Date | null;
  joined_at: Date | null;
}
function toMember(r: MemberRow): CircleMemberRecord {
  return {
    member_id: r.id,
    device_id: r.device_id,
    name: r.name,
    role: r.role,
    state: r.state,
    created_at: r.created_at.toISOString(),
    expires_at: iso(r.expires_at),
    joined_at: iso(r.joined_at),
  };
}

const INVITE_COLUMNS = "id, device_id, code, name, role, created_at, expires_at";
interface InviteRow {
  id: string;
  device_id: string;
  code: string;
  name: string;
  role: CircleInviteRecord["role"];
  created_at: Date;
  expires_at: Date;
}
function toInvite(r: InviteRow): CircleInviteRecord {
  return { invite_id: r.id, device_id: r.device_id, code: r.code, name: r.name, role: r.role, created_at: r.created_at.toISOString(), expires_at: r.expires_at.toISOString() };
}

const MESSAGE_COLUMNS = "id, device_id, from_member_id, to_member_id, client_message_id, text, created_at, expires_at";
interface MessageRow {
  id: string;
  device_id: string;
  from_member_id: string;
  to_member_id: string;
  client_message_id: string;
  text: string;
  created_at: Date;
  expires_at: Date;
}
function toMessage(r: MessageRow): CircleMessageRecord {
  return {
    message_id: r.id,
    device_id: r.device_id,
    from_member_id: r.from_member_id,
    to_member_id: r.to_member_id,
    client_message_id: r.client_message_id,
    text: r.text,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
  };
}

/**
 * Closes open help requests past their hour (`expired`, as of the hour's end): one walker's ($1), or every
 * walker's when $1 is null. $2 is now, $3 HELP_OPEN_MAX_MS.
 */
const EXPIRE_HELP = `update walker_help_requests set closed_at = created_at + make_interval(secs => $3::double precision / 1000), closed_how = 'expired'
  where closed_at is null and ($1::uuid is null or device_id = $1::uuid) and created_at + make_interval(secs => $3::double precision / 1000) <= $2`;

const HELP_COLUMNS = "id, device_id, client_help_ids, source, sent_to, shown_to, coming, created_at, closed_at, closed_how, closed_by";
interface HelpRow {
  id: string;
  device_id: string;
  client_help_ids: string[];
  source: HelpRecord["source"];
  sent_to: HelpPersonRecord[];
  shown_to: HelpPersonRecord[];
  coming: HelpPersonRecord[];
  created_at: Date;
  closed_at: Date | null;
  closed_how: NonNullable<HelpRecord["closed"]>["how"] | null;
  closed_by: HelpPersonRecord | null;
}
function toHelp(r: HelpRow): HelpRecord {
  return {
    help_id: r.id,
    device_id: r.device_id,
    client_help_ids: r.client_help_ids,
    source: r.source,
    sent_to: r.sent_to,
    shown_to: r.shown_to,
    coming: r.coming,
    created_at: r.created_at.toISOString(),
    closed: r.closed_at && r.closed_how ? { at: r.closed_at.toISOString(), how: r.closed_how, by: r.closed_by } : null,
  };
}

interface HelpMemberRow {
  id: string;
  name: string;
  role: CircleMemberRecord["role"];
  state: CircleMemberRecord["state"];
}
/** A walker's phones in joining order, as circleOf lists them. */
async function membersIn(db: PoolClient, deviceId: string): Promise<HelpMemberRow[]> {
  const { rows } = await db.query<HelpMemberRow>("select id, name, role, state from walker_circle_members where device_id = $1 order by created_at, id", [deviceId]);
  return rows;
}
const person = (m: HelpMemberRow): HelpPersonRecord => ({ member_id: m.id, name: m.name });

interface LineRow {
  event_id: string;
  kind: WalkerEventView["kind"];
  text: string;
  at: Date;
}
