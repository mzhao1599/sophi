/**
 * The walker tables, as ordered SQL migrations. PostgresWalkerStore runs the ones not yet applied at
 * server start, inside one transaction holding a Postgres advisory lock, so two instances starting at
 * once never race: the second waits, then finds them applied. A migration is never edited once it has
 * run anywhere; a change is a new entry at the end.
 *
 * No row-level security: the server is the only database client (no Data API, unlike Supabase), so
 * ownership is enforced in every query the store makes, by owner hash or device id.
 */
export const WALKER_MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: "0001_walker",
    sql: `
create table walker_devices (
  id uuid primary key,
  -- SHA-256 (hex) of the owner's walker_owner cookie and of the device credential; never the secrets.
  owner_hash text not null check (owner_hash ~ '^[0-9a-f]{64}$'),
  credential_hash text not null unique check (credential_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(name) between 1 and 40),
  service_version text not null,
  created_at timestamptz not null,
  last_heartbeat_at timestamptz,
  manifest jsonb,
  snapshot jsonb,
  -- The server's clock when the snapshot arrived; the Pi's own stamps are inside the snapshot.
  snapshot_received_at timestamptz
);
create index walker_devices_owner on walker_devices (owner_hash);

-- Immutable versions: a confirmed change adds the next one.
create table walker_configurations (
  device_id uuid not null references walker_devices (id) on delete cascade,
  version integer not null check (version > 0),
  catalog_version integer not null,
  selected_module_ids jsonb not null,
  cues jsonb not null,
  created_at timestamptz not null,
  primary key (device_id, version)
);
create function walker_configurations_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'walker configurations are never updated; add the next version';
end $$;
create trigger walker_configurations_no_update before update on walker_configurations
  for each row execute function walker_configurations_immutable();

create table walker_proposals (
  id uuid primary key,
  device_id uuid not null references walker_devices (id) on delete cascade,
  client_turn_id uuid not null,
  kind text not null check (kind = 'cues_change'),
  from_cues jsonb not null,
  cues jsonb not null,
  base_configuration_version integer not null,
  summary text not null,
  state text not null check (state in ('open', 'confirmed', 'declined', 'expired', 'superseded')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  configuration_version integer,
  check ((state = 'confirmed') = (configuration_version is not null))
);
-- One open proposal per walker.
create unique index walker_proposals_one_open on walker_proposals (device_id) where state = 'open';
create index walker_proposals_created on walker_proposals (created_at);

create table walker_turns (
  id uuid primary key,
  device_id uuid not null references walker_devices (id) on delete cascade,
  client_turn_id uuid not null,
  source text not null check (source in ('walker', 'page')),
  heard text,
  heard_by text check (heard_by in ('typed', 'gemini')),
  reply text not null,
  answered_by text not null check (answered_by in ('model', 'fixed')),
  voiced_by text check (voiced_by in ('cartesia', 'walker')),
  proposal_id uuid references walker_proposals (id) on delete set null,
  created_at timestamptz not null,
  unique (device_id, client_turn_id)
);
create index walker_turns_created on walker_turns (created_at);

-- What the walker said on its own (notices, offline replies), from heartbeats.
create table walker_lines (
  device_id uuid not null references walker_devices (id) on delete cascade,
  event_id uuid not null,
  kind text not null check (kind in ('notice', 'local_reply')),
  text text not null,
  at timestamptz not null,
  -- Arrival order, so lines said at the same moment keep the order the walker sent them in.
  seq bigint generated always as identity,
  primary key (device_id, event_id)
);
create index walker_lines_at on walker_lines (at);

create table walker_pairing_codes (
  code text primary key check (code ~ '^[0-9]{6}$'),
  owner_hash text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index walker_pairing_codes_owner on walker_pairing_codes (owner_hash);

-- Wrong codes, by a keyed hash of the client address (the key lives only in server memory), for the
-- lockout; deleted after the window.
create table walker_pairing_tries (
  address_key text not null,
  at timestamptz not null
);
create index walker_pairing_tries_address on walker_pairing_tries (address_key, at);
`,
  },
];
