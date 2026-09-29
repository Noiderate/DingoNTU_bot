/**
 * All money in this codebase is integer cents.
 *
 * Prices arrive from the FoodAndStock sheet as decimal text and receipts show
 * amounts as formatted strings, so both must be converted at the boundary and
 * never compared as floats: 0.1 + 0.2 !== 0.3, and a payment check that is a
 * cent out either rejects a valid payment or accepts a short one.
 */

/**
 * Convert a decimal price to integer cents.
 *
 * Rounding is required, not cosmetic: 5.99 * 100 evaluates to
 * 598.9999999999999 in IEEE-754 double arithmetic, and truncating would bill
 * $5.98.
 *
 * Returns null for anything unparseable, so callers must decide what an
 * unreadable price means rather than silently treating it as zero.
 */
function toCents(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = typeof value === 'number' ? value : Number(String(value).trim());

  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return Math.round(numeric * 100);
}

/**
 * Read a menu price an admin typed: "5.99", "$5.99", "6" or "1,250.50".
 *
 * Deliberately strict, since the result goes straight onto what customers pay:
 * a number above zero with at most two decimals. Anything else - "abc", "0",
 * "-3", "5.999" (which would silently round) - is null, so the admin is asked
 * again rather than the bot guessing.
 *
 * A comma only counts as a thousands separator, in groups of three. Stripping
 * commas blindly would turn a comma-as-decimal "5,99" into $599, so that is
 * refused instead.
 */
function parsePriceInput(text) {
  let cleaned = String(text === null || text === undefined ? '' : text)
    .trim()
    .replace(/^\$\s*/, '');

  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }

  const value = Number(cleaned);
  return value > 0 ? value : null;
}

/**
 * Parse a monetary amount as displayed on a Singapore bank receipt.
 *
 * Handles the forms banks actually render: "S$12.50", "SGD 1,234.50", "$8",
 * "12.50 SGD". Returns { cents, currency } with currency null when the receipt
 * showed no symbol at all.
 *
 * Deliberately strict about what counts as a number so that a garbled OCR read
 * becomes null - and therefore a flag for human review - rather than a
 * confident wrong value.
 */
function parseDisplayedAmount(text) {
  if (text === null || text === undefined) {
    return { cents: null, currency: null };
  }

  const raw = String(text).trim();
  if (!raw) {
    return { cents: null, currency: null };
  }

  const upper = raw.toUpperCase();

  let currency = null;
  if (/\bSGD\b/.test(upper) || /S\$/.test(upper)) {
    currency = 'SGD';
  } else if (/\bMYR\b|\bRM\b/.test(upper)) {
    currency = 'MYR';
  } else if (/\bUSD\b/.test(upper)) {
    currency = 'USD';
  }

  // Strip currency words and symbols, then thousands separators.
  const digitsOnly = upper
    .replace(/SGD|MYR|USD|RM|S\$|\$/g, '')
    .replace(/,/g, '')
    .trim();

  // Require a bare decimal number. Anything with stray characters is treated as
  // unreadable rather than guessed at.
  const match = digitsOnly.match(/^-?\d+(\.\d{1,2})?$/);
  if (!match) {
    return { cents: null, currency };
  }

  const numeric = Number(digitsOnly);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { cents: null, currency };
  }

  return { cents: Math.round(numeric * 100), currency };
}

/** Format integer cents for display, e.g. 1250 -> "$12.50". */
function formatCents(cents) {
  const safe = Number.isFinite(cents) ? cents : 0;
  return `$${(safe / 100).toFixed(2)}`;
}

/** Format integer cents without the symbol, for the Total column in Sheets. */
function centsToDecimalString(cents) {
  const safe = Number.isFinite(cents) ? cents : 0;
  return (safe / 100).toFixed(2);
}

module.exports = {
  toCents,
  parsePriceInput,
  parseDisplayedAmount,
  formatCents,
  centsToDecimalString,
};
