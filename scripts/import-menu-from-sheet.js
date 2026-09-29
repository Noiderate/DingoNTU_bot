#!/usr/bin/env node
const { config, assertRequiredConfig } = require('../src/config');
const googleSheets = require('../src/services/googleSheets');
const { getSupabase, unwrap } = require('../src/services/supabase');
const { planMenuImport } = require('../src/services/menuImport');

/**
 * One-time copy of the FoodAndStock tab into the menu_items table.
 *
 *   npm run menu:import              (refuses if the menu already has items)
 *   npm run menu:import -- --replace (wipes menu_items first, then imports)
 *
 * Run it once after applying supabase/migrations/0007_menu_items.sql and BEFORE
 * the first deploy: the scheduler mirrors the database back into the tab, and it
 * deliberately does nothing while the menu is empty, so an un-imported sheet is
 * never blanked - but the bot would have no food to sell.
 *
 * Each item's current sheet stock is also recorded as its opening stock (the
 * number "Reset Halls and Orders" restores). Adjust any of them afterwards in
 * the bot under Settings > Manage Food Items.
 */

async function main() {
  // The Supabase client needs Node's built-in WebSocket, added in Node 22 (see
  // "engines" in package.json). On older Node it fails with an unhelpful
  // "native WebSocket not found" the moment it is created.
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  if (nodeMajor < 22) {
    console.error(`This needs Node 22 or newer; you are on ${process.versions.node}.`);
    console.error('Install Node 22 (https://nodejs.org) and run it again.');
    process.exit(1);
  }

  const replace = process.argv.includes('--replace');

  assertRequiredConfig(['sheets', 'supabase']);

  const supabase = getSupabase();

  const existing = unwrap(
    await supabase.from('menu_items').select('id').limit(1),
    'import.checkExisting'
  );

  if (existing.length && !replace) {
    console.error('menu_items already has items. Nothing imported.');
    console.error('Re-run with --replace to wipe them and import the sheet again.');
    process.exit(1);
  }

  const sheetItems = await googleSheets.getFoodItemsOrThrow();

  if (!sheetItems.length) {
    console.error('The FoodAndStock tab has no items. Nothing imported.');
    process.exit(1);
  }

  const { rows, warnings } = planMenuImport(sheetItems);
  warnings.forEach(warning => console.warn(warning));

  if (!rows.length) {
    console.error('Nothing importable. Nothing imported.');
    process.exit(1);
  }

  if (replace && existing.length) {
    // The ids are new after this, so any cart holding an old id is discarded
    // by the checkout mismatch check rather than charged for the wrong food.
    unwrap(await supabase.from('menu_items').delete().gt('id', 0), 'import.wipe');
  }

  const inserted = unwrap(
    await supabase.from('menu_items').insert(rows).select('id, name, price_cents, stock'),
    'import.insert'
  );

  console.log(`Imported ${inserted.length} item(s):`);
  for (const item of inserted) {
    console.log(`  #${item.id}  ${item.name}  $${(item.price_cents / 100).toFixed(2)}  stock ${item.stock}`);
  }

  console.log('\nThe FoodAndStock tab now becomes a read-only mirror of this menu.');
  console.log(`(Database: ${config.supabase.url})`);
}

main().catch(error => {
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
});
