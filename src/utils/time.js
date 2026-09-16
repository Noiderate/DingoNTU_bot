const { DateTime } = require('luxon');

/**
 * Every human-facing time in this system is Singapore Time, and every stored
 * time is UTC.
 *
 * The zone is always passed explicitly. Relying on the server's local timezone
 * would mean the payment-window rules behave differently on a laptop in
 * Singapore and on a Vercel instance running in UTC - the kind of bug that only
 * shows up in production and only near midnight.
 */

const SGT = 'Asia/Singapore';

/** Format an instant for staff, e.g. "16/09/2026 14:05". */
function formatSgt(value) {
  if (!value) {
    return '';
  }

  const dt = value instanceof Date
    ? DateTime.fromJSDate(value, { zone: SGT })
    : DateTime.fromISO(String(value), { zone: SGT });

  return dt.isValid ? dt.toFormat('dd/MM/yyyy HH:mm') : '';
}

/** Longer form used in customer-facing order history. */
function formatSgtFriendly(value) {
  if (!value) {
    return '';
  }

  const dt = value instanceof Date
    ? DateTime.fromJSDate(value, { zone: SGT })
    : DateTime.fromISO(String(value), { zone: SGT });

  return dt.isValid ? dt.toFormat('d MMM yyyy, h:mm a') : '';
}

/**
 * Build a UTC instant from the date and time fields the extractor returns.
 *
 * `date` is expected as YYYY-MM-DD and `time` as HH:mm or HH:mm:ss.
 * Returns null when the time is missing, because a receipt showing only a date
 * cannot be checked against a minutes-wide payment window - that must flag for
 * review rather than be assumed to be midnight.
 */
function sgtDateTimeToUtc(date, time) {
  if (!date || !time) {
    return null;
  }

  const normalizedTime = String(time).trim();
  const format = normalizedTime.split(':').length === 3 ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd HH:mm';

  const dt = DateTime.fromFormat(
    `${String(date).trim()} ${normalizedTime}`,
    format,
    { zone: SGT }
  );

  return dt.isValid ? dt.toUTC().toJSDate() : null;
}

// Ordered most-specific first. DD/MM ordering throughout: Singapore bank apps
// never render MM/DD, and guessing wrong would silently shift a date by months.
const RECEIPT_DATETIME_FORMATS = [
  'd MMM yyyy, h:mm a',
  'd MMM yyyy h:mm a',
  'd MMM yyyy, HH:mm',
  'd MMM yyyy HH:mm',
  'd MMMM yyyy, h:mm a',
  'd MMMM yyyy h:mm a',
  'dd/MM/yyyy HH:mm:ss',
  'dd/MM/yyyy HH:mm',
  'dd/MM/yyyy h:mm a',
  'd/M/yyyy HH:mm',
  'd/M/yyyy h:mm a',
  'dd-MM-yyyy HH:mm',
  'yyyy-MM-dd HH:mm:ss',
  'yyyy-MM-dd HH:mm',
  "d MMM yyyy 'at' h:mm a",
  "d MMM yyyy 'at' HH:mm",
];

/**
 * Last-resort parser for the timestamp exactly as printed on the receipt, used
 * when the extractor could not split it into separate date and time fields.
 *
 * Returns null rather than a best guess: an unparseable timestamp flags for
 * human review, which is the safe direction.
 */
function parseReceiptDateTime(text) {
  if (!text) {
    return null;
  }

  const cleaned = String(text)
    .replace(/\s+/g, ' ')
    .replace(/ /g, ' ')
    .trim();

  for (const format of RECEIPT_DATETIME_FORMATS) {
    const dt = DateTime.fromFormat(cleaned, format, { zone: SGT, setZone: true });
    if (dt.isValid) {
      return dt.toUTC().toJSDate();
    }
  }

  // ISO with an explicit offset is unambiguous, so it is safe to accept.
  const iso = DateTime.fromISO(cleaned, { zone: SGT });
  return iso.isValid ? iso.toUTC().toJSDate() : null;
}

/**
 * Receipts commonly show times to the minute only, so comparisons are done at
 * minute granularity. Without this, a receipt reading 14:05 would be treated as
 * 14:05:00 and could fall a few seconds outside a window it genuinely satisfies.
 */
function truncateToMinute(date) {
  if (!date) {
    return null;
  }

  const copy = new Date(date.getTime());
  copy.setSeconds(0, 0);
  return copy;
}

/** Current Singapore calendar date as YYYY-MM-DD, for storage paths. */
function sgtDateParts(value = new Date()) {
  const dt = DateTime.fromJSDate(value, { zone: SGT });
  return {
    year: dt.toFormat('yyyy'),
    month: dt.toFormat('MM'),
    day: dt.toFormat('dd'),
  };
}

module.exports = {
  SGT,
  formatSgt,
  formatSgtFriendly,
  sgtDateTimeToUtc,
  parseReceiptDateTime,
  truncateToMinute,
  sgtDateParts,
};
