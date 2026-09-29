const { toCents } = require('../utils/money');

/**
 * Decide what a one-time import of the FoodAndStock tab into menu_items should
 * contain (scripts/import-menu-from-sheet.js does the reading and writing).
 *
 * Pure, so the rules can be tested without a sheet or a database:
 *  - names are unique ignoring case (the table enforces it), so the first of any
 *    duplicates wins and the rest are reported, not silently dropped;
 *  - an item whose price is not a valid number is skipped and reported, never
 *    imported at $0;
 *  - stock is rounded to a whole, non-negative number;
 *  - each item's current stock becomes its baseline, the opening stock that
 *    "Reset Halls and Orders" restores.
 *
 * Returns { rows, warnings }.
 */
function planMenuImport(sheetItems) {
  const rows = [];
  const warnings = [];
  const seen = new Set();

  for (const item of sheetItems) {
    const name = String(item.name || '').trim();
    const key = name.toLowerCase();

    if (!name) {
      continue;
    }

    if (seen.has(key)) {
      warnings.push(`Skipping duplicate name (names must be unique, ignoring case): "${name}"`);
      continue;
    }

    const priceCents = toCents(item.price);

    if (priceCents === null) {
      warnings.push(`Skipping "${name}": its price is not a valid number.`);
      continue;
    }

    seen.add(key);

    const stock = Math.max(0, Math.round(Number(item.stock) || 0));

    rows.push({ name, price_cents: priceCents, stock, baseline_stock: stock });
  }

  return { rows, warnings };
}

module.exports = { planMenuImport };
