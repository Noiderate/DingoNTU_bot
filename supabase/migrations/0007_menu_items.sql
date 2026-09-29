-- =============================================================================
-- 0007_menu_items.sql
-- The menu (food, price, stock) moves out of the FoodAndStock sheet into
-- Postgres.
--
-- Why: every browse, add-to-cart and confirm read the sheet, and every confirm
-- wrote to it, so Google's 60-reads and 60-writes-per-minute quota capped how
-- many customers could order at once. Stock also had to be deducted under one
-- global lock, because the sheet cannot do an atomic "subtract if enough is
-- left". Here that is a single statement, so checkouts no longer queue.
--
-- The FoodAndStock tab is now a one-way, read-only mirror written from this
-- table (see src/services/menuSheetSync.js). Edit the menu through the bot.
--
-- Idempotent: safe to run more than once.
-- =============================================================================


-- --- menu_items --------------------------------------------------------------

create table if not exists menu_items (
  -- A real id, not a sheet row number: it never shifts when other items are
  -- added or deleted, so a cart can't end up pointing at different food.
  id             bigint generated always as identity primary key,
  name           text        not null check (length(btrim(name)) > 0),
  price_cents    integer     not null check (price_cents >= 0),
  stock          integer     not null default 0 check (stock >= 0),

  -- What an admin last set stock to by hand. "Reset Halls and Orders" puts stock
  -- back to this, undoing the night's consumption. Null until a manual edit.
  baseline_stock integer     check (baseline_stock >= 0),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists menu_items_set_updated_at on menu_items;
create trigger menu_items_set_updated_at
  before update on menu_items
  for each row execute function set_updated_at();

-- Names identify an item in carts, order snapshots and messages, so two items
-- may not differ only by case.
create unique index if not exists menu_items_name_key
  on menu_items (lower(name));


-- --- Atomic stock functions --------------------------------------------------

/**
 * Deduct stock for a checkout, all or nothing.
 *
 * p_items is [{ "id": 3, "quantity": 2 }, ...]. Every row is locked in id order
 * (a fixed order means two checkouts can never deadlock), then either EVERY item
 * has enough stock and all are deducted, or nothing changes.
 *
 * Returns
 *   { ok: true,  changes: [{ id, name, old_stock, new_stock }, ...] }
 *   { ok: false, reason: 'missing',      item_id }
 *   { ok: false, reason: 'insufficient', item_id, name, available }
 *
 * The changes carry the stock levels as they really were at deduction time, so a
 * "sold out" announcement is only raised by the checkout that emptied the item.
 */
create or replace function deduct_menu_stock(p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_short   record;
  v_changes jsonb;
begin
  perform 1
  from menu_items
  where id in (select (e->>'id')::bigint from jsonb_array_elements(p_items) e)
  order by id
  for update;

  select w.id, w.qty, m.name, m.stock
    into v_short
  from (
    select (e->>'id')::bigint as id, sum((e->>'quantity')::integer) as qty
    from jsonb_array_elements(p_items) e
    group by 1
  ) w
  left join menu_items m on m.id = w.id
  where w.qty > 0 and (m.id is null or m.stock < w.qty)
  order by w.id
  limit 1;

  if found then
    if v_short.name is null then
      return jsonb_build_object('ok', false, 'reason', 'missing', 'item_id', v_short.id);
    end if;

    return jsonb_build_object(
      'ok', false,
      'reason', 'insufficient',
      'item_id', v_short.id,
      'name', v_short.name,
      'available', v_short.stock
    );
  end if;

  with wanted as (
    select (e->>'id')::bigint as id, sum((e->>'quantity')::integer) as qty
    from jsonb_array_elements(p_items) e
    group by 1
  ),
  updated as (
    update menu_items m
       set stock = m.stock - w.qty
      from wanted w
     where m.id = w.id and w.qty > 0
    returning m.id, m.name, m.stock + w.qty as old_stock, m.stock as new_stock
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', id, 'name', name, 'old_stock', old_stock, 'new_stock', new_stock
             )
             order by id
           ),
           '[]'::jsonb
         )
    into v_changes
  from updated;

  return jsonb_build_object('ok', true, 'changes', v_changes);
end;
$$;

/**
 * Put stock back (a rejected, expired or failed order), all or nothing.
 *
 * p_items is [{ "id": 3, "quantity": 2 }, ...]. If every item still exists,
 * all are restocked and { updated: <rows> } is returned. If any was deleted from
 * the menu in the meantime, NOTHING is restocked and { updated: 0, missing: <n> }
 * comes back - so the caller can tell the admins to add the whole order back by
 * hand without double-counting items that were in fact restocked.
 */
create or replace function restore_menu_stock(p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_wanted  integer;
  v_found   integer;
  v_updated integer;
begin
  -- Lock in id order, as deduct_menu_stock does, so the two can never deadlock.
  perform 1
  from menu_items
  where id in (select (e->>'id')::bigint from jsonb_array_elements(p_items) e)
  order by id
  for update;

  with wanted as (
    select (e->>'id')::bigint as id, sum((e->>'quantity')::integer) as qty
    from jsonb_array_elements(p_items) e
    group by 1
  )
  select count(*) filter (where w.qty > 0),
         count(*) filter (where w.qty > 0 and m.id is not null)
    into v_wanted, v_found
  from wanted w
  left join menu_items m on m.id = w.id;

  if v_found < v_wanted then
    return jsonb_build_object('updated', 0, 'missing', v_wanted - v_found);
  end if;

  with wanted as (
    select (e->>'id')::bigint as id, sum((e->>'quantity')::integer) as qty
    from jsonb_array_elements(p_items) e
    group by 1
  )
  update menu_items m
     set stock = m.stock + w.qty
    from wanted w
   where m.id = w.id and w.qty > 0;

  get diagnostics v_updated = row_count;

  return jsonb_build_object('updated', v_updated);
end;
$$;

/**
 * "Reset Halls and Orders": set every item that has a baseline back to it.
 *
 * One statement, so it cannot clobber a checkout that lands mid-reset the way a
 * read-then-write from the application could. Returns the items that actually
 * changed: [{ id, name, old_stock, new_stock }, ...].
 */
create or replace function restore_menu_baselines()
returns jsonb
language plpgsql
as $$
declare
  v_changes jsonb;
begin
  with target as (
    select id, name, stock as old_stock, baseline_stock
    from menu_items
    where baseline_stock is not null and stock <> baseline_stock
    for update
  ),
  updated as (
    update menu_items m
       set stock = t.baseline_stock
      from target t
     where m.id = t.id
    returning m.id
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', t.id, 'name', t.name,
               'old_stock', t.old_stock, 'new_stock', t.baseline_stock
             )
             order by t.id
           ),
           '[]'::jsonb
         )
    into v_changes
  from target t
  join updated u on u.id = t.id;

  return v_changes;
end;
$$;


-- --- Row Level Security ------------------------------------------------------
-- Same as every other table: enabled with no policies, so only the service role
-- key (server-side) can read or write it.

alter table menu_items enable row level security;
