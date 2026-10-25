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
  {
    id: "0002_walker_turn_order",
    sql: `
-- Arrival order, so turns stored at the same moment are listed in the order they were saved.
alter table walker_turns add column seq bigint generated always as identity;
`,
  },
  {
    id: "0003_walker_circle_phones",
    sql: `
-- The two-phone circle: her own phone (walker_user) and caretakers, added by the owner with a code.
-- Everything hangs off the walker, so forgetting it deletes its circle. Wrong codes go in
-- walker_pairing_tries under their own address key (same limits, separate count).
create table walker_circle_members (
  id uuid primary key,
  device_id uuid not null references walker_devices (id) on delete cascade,
  -- SHA-256 (hex) of the phone's walker_member cookie; never the secret.
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(name) between 1 and 12),
  role text not null check (role in ('walker_user', 'caregiver')),
  state text not null check (state in ('waiting', 'member')),
  created_at timestamptz not null,
  expires_at timestamptz,
  joined_at timestamptz,
  -- The browser's earlier membership, which this one replaces once it is in (no foreign key: it may be gone).
  replaces_member_id uuid,
  check ((state = 'member') = (joined_at is not null)),
  check ((state = 'waiting') = (expires_at is not null)),
  check (state = 'member' or role = 'caregiver')
);
create index walker_circle_members_device on walker_circle_members (device_id, created_at);
-- Her own phone: one per walker.
create unique index walker_circle_one_walker_user on walker_circle_members (device_id) where role = 'walker_user';

create table walker_circle_invites (
  id uuid primary key,
  device_id uuid not null references walker_devices (id) on delete cascade,
  code text not null unique check (code ~ '^[0-9]{6}$'),
  name text not null check (char_length(name) between 1 and 12),
  role text not null check (role in ('walker_user', 'caregiver')),
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index walker_circle_invites_device on walker_circle_invites (device_id);

-- Short messages between the phones. Deleted 24 hours after sending, and with either phone.
create table walker_circle_messages (
  id uuid primary key,
  device_id uuid not null references walker_devices (id) on delete cascade,
  from_member_id uuid not null references walker_circle_members (id) on delete cascade,
  to_member_id uuid not null references walker_circle_members (id) on delete cascade,
  client_message_id uuid not null,
  text text not null check (char_length(text) <= 30),
  -- Cleared by the newest-20 limit: the text is gone, and the row stays (until expires_at) only so a
  -- retried send of it isn't saved again.
  cleared boolean not null default false,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  seq bigint generated always as identity,
  unique (from_member_id, client_message_id),
  check (cleared = (text = ''))
);
create index walker_circle_messages_device on walker_circle_messages (device_id, created_at, seq);
create index walker_circle_messages_expires on walker_circle_messages (expires_at);
`,
  },
  {
    id: "0004_walker_location_sharing",
    sql: `
-- One current fix only. No trail, and sharing starts disabled on every walker.
alter table walker_devices
  add column location_sharing_enabled boolean not null default false,
  add column location jsonb,
  add column location_received_at timestamptz;
`,
  },
  {
    id: "0005_walker_help",
    sql: `
-- Help requests (docs/subsystems/help.md): she asked her caretakers for help. At most one open per walker.
-- Deleted 24 hours after she asked, open or not, by the circle's sweep, and with the walker by cascade.
-- No location is ever stored here. People are [{member_id, name}] (JSON, no foreign key: a removed phone stays
-- named): sent_to (the approved caretakers when she asked, fixed then), shown_to (caretaker phones whose app
-- received it while open), coming ("I'm on my way"), closed_by (null for expired, and for the walker's okay with
-- no phone of hers in). client_help_ids: its own id first, then ids of asks made while it was open (retries).
create table walker_help_requests (
  id uuid primary key,
  device_id uuid not null references walker_devices (id) on delete cascade,
  client_help_ids jsonb not null check (jsonb_typeof(client_help_ids) = 'array' and jsonb_array_length(client_help_ids) between 1 and 50),
  source text not null check (source in ('handles', 'voice', 'phone')),
  sent_to jsonb not null check (jsonb_typeof(sent_to) = 'array' and jsonb_array_length(sent_to) between 1 and 8),
  shown_to jsonb not null default '[]'::jsonb check (jsonb_typeof(shown_to) = 'array' and jsonb_array_length(shown_to) <= 8),
  coming jsonb not null default '[]'::jsonb check (jsonb_typeof(coming) = 'array' and jsonb_array_length(coming) <= 8),
  created_at timestamptz not null,
  closed_at timestamptz,
  closed_how text check (closed_how in ('okay', 'with_her', 'expired')),
  closed_by jsonb,
  seq bigint generated always as identity,
  check ((closed_at is null) = (closed_how is null)),
  check (closed_how = 'okay' or (closed_how = 'with_her') = (closed_by is not null))
);
create unique index walker_help_one_open on walker_help_requests (device_id) where closed_at is null;
create index walker_help_device on walker_help_requests (device_id, created_at);
create index walker_help_created on walker_help_requests (created_at);
`,
  },
  {
    id: "0006_walker_heard_by_cartesia",
    sql: `
-- Spoken turns are now transcribed by Cartesia and answered by Claude, so heard_by says 'cartesia'. Turns heard
-- the old way are deleted rather than relabelled (who heard them is a fact); turns are kept only an hour anyway
-- (WALKER_HISTORY_RETENTION_MS), so this removes at most the last hour's spoken turns.
delete from walker_turns where heard_by = 'gemini';
alter table walker_turns drop constraint walker_turns_heard_by_check;
alter table walker_turns add constraint walker_turns_heard_by_check check (heard_by in ('typed', 'cartesia'));
`,
  },
];
