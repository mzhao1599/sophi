-- Onboarding persistence: the smallest slice of the durable data model in docs/agent-runtime.md.
--
-- * onboarding_sessions: one row per onboarding conversation. A demo session has no owner account;
--   whoever holds its secret token owns it, and only the server (service role) reads it, by the
--   token's SHA-256 hash. An account session belongs to a signed-in user and is read through that
--   user's own token, so row-level security decides what comes back.
-- * onboarding_turn_results: the response each turn got, so a retried turn returns the same result.
-- * device_configurations: a signed-in user's confirmed setups, numbered 1, 2, 3… per user and never
--   changed after they are written.
--
-- Answers can reveal disability, so: no table is readable by the anon role, every user-owned table
-- has row-level security, and retention is enforced here (expiry bounds on every write, and
-- delete_expired_onboarding_sessions).

-- ---------------------------------------------------------------------------------------------
-- Tables

create table public.onboarding_sessions (
  id uuid primary key,
  -- The signed-in owner. Null for a demo session.
  user_id uuid references auth.users (id) on delete cascade,
  -- SHA-256 (hex) of a demo session's secret token; the token itself is only in the caller's cookie.
  demo_token_hash text,
  -- Where the conversation stood at the last save. "expired" is worked out from expires_at instead.
  state text not null check (state in ('collecting', 'review', 'confirmed')),
  revision integer not null check (revision >= 0),
  catalog_version integer not null check (catalog_version > 0),
  -- The whole engine session (EngineSession in services/cloud-api/src/onboarding/engine.ts): the
  -- transcript, the answers and facts, and the confirmed configuration.
  engine_state jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_sessions_one_owner check ((user_id is null) <> (demo_token_hash is null)),
  constraint onboarding_sessions_token_hash_format check (demo_token_hash is null or demo_token_hash ~ '^[0-9a-f]{64}$')
);

create index onboarding_sessions_user_idx on public.onboarding_sessions (user_id, updated_at desc) where user_id is not null;
create index onboarding_sessions_expires_idx on public.onboarding_sessions (expires_at);
-- For counting live demo sessions (the store caps them).
create index onboarding_sessions_demo_expires_idx on public.onboarding_sessions (expires_at) where user_id is null;

-- Whoever writes a row, it can't be kept longer than its kind allows: a demo session an hour after
-- its last change, an account session 30 days (five minutes' slack for clock differences). And a
-- row counts as confirmed exactly when its engine state holds a configuration, which is what keeps
-- it past expiry.
create function public.bound_onboarding_session() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.expires_at := least(
    new.expires_at,
    now() + case when new.user_id is null then interval '1 hour' else interval '30 days' end + interval '5 minutes'
  );
  if jsonb_typeof(new.engine_state -> 'configuration') = 'object' then
    new.state := 'confirmed';
  elsif new.state = 'confirmed' then
    new.state := 'review';
  end if;
  return new;
end;
$$;

create trigger onboarding_sessions_bounded
  before insert or update on public.onboarding_sessions
  for each row execute function public.bound_onboarding_session();

create table public.onboarding_turn_results (
  session_id uuid not null references public.onboarding_sessions (id) on delete cascade,
  client_turn_id uuid not null,
  -- The TurnResponse the turn got (packages/contracts/src/onboarding.ts).
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, client_turn_id)
);

create table public.device_configurations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The session the setup was confirmed in. Deleting that session is the only way to delete the
  -- setup, so a setup and the answers it came from always go together.
  session_id uuid not null unique references public.onboarding_sessions (id) on delete cascade,
  configuration_version integer not null check (configuration_version > 0),
  catalog_version integer not null check (catalog_version > 0),
  -- The DeviceConfiguration document (packages/contracts/src/onboarding.ts).
  configuration jsonb not null,
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, configuration_version)
);

-- A confirmed setup is a record of what the user agreed to; a change is a new version, not an edit.
create function public.reject_device_configuration_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'device_configurations rows are immutable; confirm a new version instead'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger device_configurations_immutable
  before update on public.device_configurations
  for each row execute function public.reject_device_configuration_update();

revoke execute on function public.reject_device_configuration_update() from public, anon, authenticated;
revoke execute on function public.bound_onboarding_session() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Privileges and row-level security
--
-- Supabase grants every new public table to anon and authenticated by default. Take that back:
-- anon gets nothing; authenticated can read its own rows of all three tables and write its own
-- sessions; turn results and setups are written only by save_onboarding_session (below), and a
-- setup is deleted only with its session. service_role (the server, for demo sessions) keeps full
-- access and bypasses RLS.

revoke all on public.onboarding_sessions, public.onboarding_turn_results, public.device_configurations from anon, authenticated;
grant select, insert, update, delete on public.onboarding_sessions to authenticated;
grant select on public.onboarding_turn_results to authenticated;
grant select on public.device_configurations to authenticated;

alter table public.onboarding_sessions enable row level security;
alter table public.onboarding_turn_results enable row level security;
alter table public.device_configurations enable row level security;

-- Demo rows have user_id null, so no authenticated user ever matches them.
create policy "Owners read their sessions" on public.onboarding_sessions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Owners start their sessions" on public.onboarding_sessions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owners update their sessions" on public.onboarding_sessions
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Owners delete their sessions" on public.onboarding_sessions
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "Owners read their turn results" on public.onboarding_turn_results
  for select to authenticated
  using (exists (select 1 from public.onboarding_sessions s where s.id = session_id and s.user_id = (select auth.uid())));

create policy "Owners read their setups" on public.device_configurations
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- Saving a turn
--
-- One transaction: the session is updated only if its revision is still the one the turn started
-- from (so of two overlapping turns only one lands), and the turn's response and, on confirmation,
-- the setup are written with it. Returns false, having changed nothing, on a stale revision or a
-- setup number that isn't the owner's next one.
--
-- security definer, because callers can't write turn results or setups themselves, so ownership is
-- checked here instead of by RLS:
-- * without p_demo_token_hash: the caller's own account session only (auth.uid(), from their token);
-- * with p_demo_token_hash: only the server (service_role), and only the demo row with that hash.

create function public.save_onboarding_session(
  p_id uuid,
  p_expected_revision integer,
  p_revision integer,
  p_state text,
  p_engine_state jsonb,
  p_expires_at timestamptz,
  p_demo_token_hash text default null,
  p_client_turn_id uuid default null,
  p_response jsonb default null,
  p_configuration jsonb default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := auth.jwt() ->> 'role';
  v_user uuid;
begin
  if p_demo_token_hash is null then
    if v_uid is null then
      return false;
    end if;
    if p_configuration is not null then
      -- Setups are numbered 1, 2, 3… per user: this one must be the next number. The lock makes two
      -- confirmations by one user take turns.
      perform pg_advisory_xact_lock(hashtextextended('device_configurations:' || v_uid::text, 0));
      if (p_configuration ->> 'configuration_version')::integer is distinct from
         (select coalesce(max(c.configuration_version), 0) + 1 from public.device_configurations c where c.user_id = v_uid) then
        return false;
      end if;
    end if;
    update public.onboarding_sessions
       set revision = p_revision, state = p_state, engine_state = p_engine_state, expires_at = p_expires_at, updated_at = now()
     where id = p_id and revision = p_expected_revision and user_id = v_uid
    returning user_id into v_user;
  else
    if v_role is distinct from 'service_role' or p_configuration is not null then
      return false;
    end if;
    update public.onboarding_sessions
       set revision = p_revision, state = p_state, engine_state = p_engine_state, expires_at = p_expires_at, updated_at = now()
     where id = p_id and revision = p_expected_revision and user_id is null and demo_token_hash = p_demo_token_hash;
  end if;

  if not found then
    return false;
  end if;

  if p_client_turn_id is not null then
    insert into public.onboarding_turn_results (session_id, client_turn_id, response)
    values (p_id, p_client_turn_id, p_response);
    -- Only the latest turns are ever retried; keep the 5 newest results per session.
    delete from public.onboarding_turn_results r
     where r.session_id = p_id
       and r.client_turn_id not in (
         select k.client_turn_id from public.onboarding_turn_results k
          where k.session_id = p_id order by k.created_at desc limit 5);
  end if;

  if p_configuration is not null then
    insert into public.device_configurations (user_id, session_id, configuration_version, catalog_version, configuration, confirmed_at)
    values (
      v_user,
      p_id,
      (p_configuration ->> 'configuration_version')::integer,
      (p_configuration ->> 'catalog_version')::integer,
      p_configuration,
      (p_configuration ->> 'confirmed_at')::timestamptz
    );
  end if;

  return true;
end;
$$;

revoke execute on function public.save_onboarding_session(uuid, integer, integer, text, jsonb, timestamptz, text, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.save_onboarding_session(uuid, integer, integer, text, jsonb, timestamptz, text, uuid, jsonb, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Retention
--
-- Demo sessions: deleted once expired (an hour after the last change), confirmed or not.
-- Account sessions: an unfinished one is deleted once expired (30 days after the last change); a
-- confirmed one stays, with its setup, until the user deletes it or their account.
-- The server also refuses expired sessions, so this job only has to remove the data. It runs as
-- the database owner from pg_cron; nobody can call it through the API.

create function public.delete_expired_onboarding_sessions() returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.onboarding_sessions
     where expires_at < now()
       and (user_id is null or state <> 'confirmed')
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function public.delete_expired_onboarding_sessions() from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'delete-expired-onboarding-sessions',
  '*/5 * * * *',
  'select public.delete_expired_onboarding_sessions()'
);
