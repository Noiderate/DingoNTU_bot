-- =============================================================================
-- 0004_order_code.sql
-- Allocates human-readable order codes of the form DG20260916-7.
--
-- The trailing number restarts at 1 each day, so codes stay short enough to
-- read aloud during a delivery run. The date prefix is what makes them unique.
--
-- The day boundary is Asia/Singapore, NOT UTC: an order placed at 1am SGT must
-- carry that day's date, and UTC would put it on the previous day.
--
-- Replaces the old in-memory `let nextOrderId = 1` counter, which restarted on
-- every process restart and therefore produced colliding ids.
-- =============================================================================

create table if not exists order_code_counters (
  day        date        primary key,
  last_value integer     not null default 0,
  updated_at timestamptz not null default now()
);

alter table order_code_counters enable row level security;

/**
 * Atomically reserve the next order code for the current Singapore day.
 *
 * The INSERT ... ON CONFLICT DO UPDATE takes a row lock, so concurrent callers
 * queue rather than racing: two orders placed in the same millisecond receive
 * different numbers.
 */
create or replace function allocate_order_code()
returns text
language plpgsql
as $$
declare
  v_day  date;
  v_next integer;
begin
  v_day := (now() at time zone 'Asia/Singapore')::date;

  insert into order_code_counters (day, last_value)
  values (v_day, 1)
  on conflict (day) do update
    set last_value = order_code_counters.last_value + 1,
        updated_at = now()
  returning last_value into v_next;

  return 'DG' || to_char(v_day, 'YYYYMMDD') || '-' || v_next::text;
end;
$$;
