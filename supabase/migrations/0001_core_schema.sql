-- =============================================================================
-- 0001_core_schema.sql
-- Customers, orders, order items and the append-only status history.
--
-- Idempotent: safe to run more than once.
-- All money is INTEGER CENTS. Never store or compare monetary floats.
-- All timestamps are timestamptz stored in UTC; Asia/Singapore is applied only
-- when formatting for humans.
-- =============================================================================

create extension if not exists "pgcrypto";

-- --- Enums -------------------------------------------------------------------
-- Postgres has no CREATE TYPE IF NOT EXISTS, hence the exception guard.

do $$ begin
  create type order_status as enum (
    'pending_admin_confirmation',
    'awaiting_payment',
    'verifying_payment',
    'payment_flagged',
    'paid',
    'served',
    'rejected',
    'cancelled',
    'expired'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type actor_type as enum ('customer', 'admin', 'system', 'ai_verifier');
exception when duplicate_object then null;
end $$;


-- --- Shared updated_at trigger ------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- --- customers ---------------------------------------------------------------

create table if not exists customers (
  id                uuid primary key default gen_random_uuid(),
  telegram_user_id  bigint      not null unique,
  telegram_username text,
  first_name        text,
  last_name         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();


-- --- orders ------------------------------------------------------------------

create table if not exists orders (
  id                   uuid primary key default gen_random_uuid(),

  -- Human-readable, e.g. DG20260916-7. Unique; the number restarts each day.
  order_code           text not null unique,

  customer_id          uuid not null references customers (id),
  telegram_chat_id     bigint not null,

  -- Snapshotted at order time. hall_sheet_row_id is the Hall tab row number,
  -- which shifts if staff reorder or delete rows, so the name snapshot is what
  -- we actually trust. See MAINTENANCE.md "Row-number-as-ID".
  hall_sheet_row_id    integer,
  hall_name_snapshot   text not null,

  status               order_status not null default 'pending_admin_confirmation',

  subtotal_cents       integer not null default 0 check (subtotal_cents >= 0),
  total_cents          integer not null default 0 check (total_cents >= 0),

  -- Nullable: no delivery flow exists today (hall pickup only). Present so the
  -- feature can be added later without a migration.
  recipient_name       text,
  contact_number       text,
  delivery_address     text,
  postal_code          text,
  delivery_notes       text,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  admin_confirmed_at   timestamptz,
  payment_requested_at timestamptz,
  payment_due_at       timestamptz,
  paid_at              timestamptz,
  served_at            timestamptz,
  rejected_at          timestamptz,

  rejection_reason     text,

  -- Google Sheets mirror tracking. sheet_synced_at < updated_at means the row
  -- is stale and the reconciler should re-push it.
  sheet_synced_at      timestamptz,
  sheet_sync_error     text
);

drop trigger if exists orders_set_updated_at on orders;
create trigger orders_set_updated_at
  before update on orders
  for each row execute function set_updated_at();

create index if not exists orders_customer_created_idx
  on orders (customer_id, created_at desc);
create index if not exists orders_status_idx
  on orders (status);
create index if not exists orders_hall_status_idx
  on orders (hall_name_snapshot, status);
-- Drives the expiry sweeper.
create index if not exists orders_payment_due_idx
  on orders (payment_due_at)
  where status in ('awaiting_payment', 'verifying_payment');
-- Drives the sheet reconciler.
create index if not exists orders_sheet_stale_idx
  on orders (sheet_synced_at)
  where sheet_synced_at is null or sheet_sync_error is not null;


-- --- order_items -------------------------------------------------------------

create table if not exists order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders (id) on delete cascade,

  food_sheet_row_id  integer,

  -- Snapshots, so an order still reads correctly after the menu changes.
  item_name_snapshot text    not null,
  category_snapshot  text,
  unit_price_cents   integer not null check (unit_price_cents >= 0),

  quantity           integer not null check (quantity > 0),

  -- No add-on feature exists today; shape reserved so one can be added later.
  addons             jsonb   not null default '[]'::jsonb,
  line_total_cents   integer not null check (line_total_cents >= 0),

  created_at         timestamptz not null default now()
);

create index if not exists order_items_order_idx on order_items (order_id);


-- --- order_status_history (append-only) --------------------------------------

create table if not exists order_status_history (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders (id) on delete cascade,
  from_status       order_status,
  to_status         order_status not null,
  actor             actor_type   not null,
  actor_telegram_id bigint,
  reason            text,
  created_at        timestamptz  not null default now()
);

create index if not exists order_status_history_order_idx
  on order_status_history (order_id, created_at);


-- --- Permanence guard --------------------------------------------------------
-- Status history is audit evidence and must never be deleted or rewritten.

create or replace function forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Table % is append-only: % is not permitted. This is an audit trail.',
    tg_table_name, tg_op;
end;
$$;

drop trigger if exists order_status_history_no_delete on order_status_history;
create trigger order_status_history_no_delete
  before delete or update on order_status_history
  for each row execute function forbid_mutation();


-- --- Row Level Security ------------------------------------------------------
-- Enabled with NO policies: every table is unreachable via the anon and
-- authenticated keys. Only the service role key (server-side) can read or
-- write, because it bypasses RLS. Never disable this.

alter table customers            enable row level security;
alter table orders               enable row level security;
alter table order_items          enable row level security;
alter table order_status_history enable row level security;
