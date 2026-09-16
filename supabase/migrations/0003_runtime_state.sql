-- =============================================================================
-- 0003_runtime_state.sql
-- Everything that used to live in module-level JavaScript variables.
--
-- On Vercel each request may run in a different instance and memory does not
-- survive, so any state that must outlive a single request lives here.
-- =============================================================================


-- --- processed_updates -------------------------------------------------------
-- Telegram redelivers an update if it does not get a timely 2xx. Inserting the
-- update_id with ON CONFLICT DO NOTHING makes handling exactly-once: if the row
-- already exists, the webhook returns 200 without reprocessing.
-- Rows older than a day are pruned by the sweeper.

create table if not exists processed_updates (
  update_id    bigint      primary key,
  processed_at timestamptz not null default now()
);

create index if not exists processed_updates_processed_at_idx
  on processed_updates (processed_at);


-- --- bot_state ---------------------------------------------------------------
-- Generic key/value store for small pieces of runtime state: admin multi-step
-- input, the delivery-mode sequencer position, posted channel message ids, the
-- admin menu message id per chat, cached Telegram file_ids.
--
-- expires_at is evaluated lazily on read (never by a timer) and pruned by the
-- sweeper.

create table if not exists bot_state (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists bot_state_expires_idx
  on bot_state (expires_at)
  where expires_at is not null;


-- --- locks -------------------------------------------------------------------
-- Postgres-backed lease locks. These replace the in-process promise-chain mutex
-- that used to guard stock deduction; a promise chain only serialises ONE
-- process, so it cannot prevent overselling once several instances run at once.

create table if not exists locks (
  name        text        primary key,
  holder      text        not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists locks_expires_idx on locks (expires_at);

/**
 * Acquire a lease lock. Returns true only if the lock was free or its previous
 * lease had already expired, so an instance killed mid-critical-section cannot
 * block the lock forever.
 *
 * Atomic by construction: the conditional ON CONFLICT means two concurrent
 * callers cannot both receive true.
 */
create or replace function try_acquire_lock(
  p_name     text,
  p_holder   text,
  p_lease_ms integer
)
returns boolean
language plpgsql
as $$
declare
  v_acquired boolean;
begin
  insert into locks (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_lease_ms / 1000.0))
  on conflict (name) do update
    set holder      = excluded.holder,
        expires_at  = excluded.expires_at,
        acquired_at = now()
    where locks.expires_at < now()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

/**
 * Release a lock, but only if we still hold it. The holder check matters: if
 * our lease expired and another worker took over, we must not delete theirs.
 */
create or replace function release_lock(p_name text, p_holder text)
returns boolean
language plpgsql
as $$
declare
  v_deleted integer;
begin
  delete from locks where name = p_name and holder = p_holder;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;


-- --- carts -------------------------------------------------------------------
-- Replaces the in-memory userHalls / userCarts objects in src/handlers/user.js.
-- items maps a FoodAndStock row number to a quantity, e.g. {"2": 3, "5": 1}.

create table if not exists carts (
  telegram_user_id  bigint      primary key,
  hall_sheet_row_id integer,
  hall_name         text,
  items             jsonb       not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  expires_at        timestamptz
);

drop trigger if exists carts_set_updated_at on carts;
create trigger carts_set_updated_at
  before update on carts
  for each row execute function set_updated_at();

create index if not exists carts_expires_idx
  on carts (expires_at)
  where expires_at is not null;


-- --- halls_state -------------------------------------------------------------
-- Replaces the in-memory blockedHallNames array.
--
-- Presence of a row means the hall is blocked. blocked_until is nullable and a
-- NULL means "blocked until an admin resets it", which is exactly how the bot
-- behaves today: the 3-hour auto-reset in the old orderStore.js was never wired
-- up to anything. The column exists so auto-expiry can be switched on later
-- without a migration; it is evaluated lazily on read, never by a timer.
--
-- blocked_at gives the ordering that "Revert last blocked hall" relies on.

create table if not exists halls_state (
  hall_name     text        primary key,
  blocked_at    timestamptz not null default now(),
  blocked_until timestamptz,
  blocked_by    bigint
);

create index if not exists halls_state_blocked_at_idx
  on halls_state (blocked_at desc);


-- --- sheet_sync_outbox -------------------------------------------------------
-- An order change writes a row here in the SAME request that commits the change
-- to Postgres. The outbox is drained after the response via waitUntil, and
-- again by the scheduled worker. This keeps a Sheets outage or quota error from
-- ever breaking the ordering flow.

create table if not exists sheet_sync_outbox (
  id              uuid        primary key default gen_random_uuid(),
  order_id        uuid        not null references orders (id) on delete cascade,
  enqueued_at     timestamptz not null default now(),
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  locked_by       text,
  last_error      text
);

create index if not exists sheet_sync_outbox_queue_idx
  on sheet_sync_outbox (next_attempt_at);

-- At most one pending outbox row per order: repeated changes coalesce into a
-- single push of the order's current state, which keeps us inside Sheets quota.
create unique index if not exists sheet_sync_outbox_order_idx
  on sheet_sync_outbox (order_id);


-- --- Row Level Security ------------------------------------------------------

alter table processed_updates  enable row level security;
alter table bot_state          enable row level security;
alter table locks              enable row level security;
alter table carts              enable row level security;
alter table halls_state        enable row level security;
alter table sheet_sync_outbox  enable row level security;
