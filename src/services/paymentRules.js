const { parseDisplayedAmount } = require('../utils/money');
const {
  sgtDateTimeToUtc, parseReceiptDateTime, parseReceiptDate, sgtIsoDate, truncateToMinute,
} = require('../utils/time');

/**
 * The deterministic payment decision engine.
 *
 * THE MODEL EXTRACTS, THIS CODE DECIDES. Gemini only reports what it can see on
 * the screenshot; nothing it returns can approve a payment by itself. Every
 * approve/flag/reject verdict is made here, in a pure function with no I/O, so
 * it can be exhaustively unit tested and reasoned about.
 *
 * Every check runs even after an earlier one fails, so `reasons` is the
 * complete list of what was wrong. That matters for the audit trail and for
 * diagnosing a sudden rise in flag rates after a bank redesigns its app.
 */

const OUTCOMES = {
  AUTO_APPROVED: 'auto_approved',
  FLAGGED: 'flagged',
  INCOMPLETE_TRANSFER: 'incomplete_transfer',
  DUPLICATE_REJECTED: 'duplicate_rejected',
  // Everything checked out except that no reference number was visible: the
  // customer is asked to resend one that shows it (see decideOutcome).
  MISSING_REFERENCE: 'missing_reference',
};

const REASONS = {
  NOT_A_RECEIPT: 'NOT_A_RECEIPT',
  UNREADABLE: 'UNREADABLE',
  INCOMPLETE_TRANSFER: 'INCOMPLETE_TRANSFER',
  MISSING_REFERENCE: 'MISSING_REFERENCE',
  DUPLICATE_REFERENCE: 'DUPLICATE_REFERENCE',
  DUPLICATE_IMAGE: 'DUPLICATE_IMAGE',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  RECIPIENT_UNVERIFIABLE: 'RECIPIENT_UNVERIFIABLE',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  AMOUNT_UNREADABLE: 'AMOUNT_UNREADABLE',
  OVERPAID: 'OVERPAID',
  TIMESTAMP_TOO_OLD: 'TIMESTAMP_TOO_OLD',
  TIMESTAMP_IN_FUTURE: 'TIMESTAMP_IN_FUTURE',
  TIMESTAMP_BEFORE_ORDER: 'TIMESTAMP_BEFORE_ORDER',
  TIMESTAMP_UNREADABLE: 'TIMESTAMP_UNREADABLE',
  SUSPECTED_EDIT: 'SUSPECTED_EDIT',
  CROPPED: 'CROPPED',
  // Not produced by the rules themselves: set by the verifier when Gemini could
  // not be reached at all, so the receipt still reaches a human.
  GEMINI_VERIFICATION_FAILURE: 'GEMINI_VERIFICATION_FAILURE',
};

// Company-suffix noise that differs between banks for the same payee.
const LEGAL_SUFFIXES = /\b(pte|ptd|ltd|limited|llp|llc|inc|co|company)\b/g;

const MASK_CHARACTERS = /[*•·#]/;


// --- Normalisation -----------------------------------------------------------

/**
 * Canonical form of a bank reference, used as the replay-guard key.
 *
 * Banks print the same reference with varying separators and spacing, so
 * without this the identical receipt could be claimed twice.
 */
function normalizeReference(raw) {
  if (!raw) {
    return null;
  }

  const normalized = String(raw)
    .toUpperCase()
    .replace(/[\s\-/_.]/g, '')
    .trim();

  return normalized || null;
}

/**
 * Canonical form of a payee display name.
 *
 * Banks render the same payee inconsistently - "DINGO CAFE PTE LTD",
 * "Dingo Cafe", "DINGO  CAFE." - so punctuation, case, spacing and legal
 * suffixes are all stripped before comparison.
 */
function normalizeRecipientName(raw) {
  if (!raw) {
    return null;
  }

  const normalized = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || null;
}

function normalizeUen(raw) {
  if (!raw) {
    return null;
  }

  const normalized = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
  return normalized || null;
}

/**
 * Whether a normalised value has the shape of a Singapore UEN:
 *   nnnnnnnnX    businesses (8 digits + check letter)
 *   yyyynnnnnX   local companies (9 digits + check letter)
 *   TyyPQnnnnX   other entities (T/S/R, year, 2-char entity type, 4 digits, letter)
 *
 * Needed because DBS/POSB label the bill reference "UEN/Bill Reference No.",
 * and our PayNow QR puts the order code (e.g. DG20261126-10) there. Without
 * this check that order code was read as the payee's UEN and every such
 * receipt failed as a recipient mismatch.
 */
const UEN_PATTERN = /^(\d{8}[A-Z]|\d{9}[A-Z]|[RST]\d{2}[A-Z0-9]{2}\d{4}[A-Z])$/;

function isPlausibleUen(normalized) {
  return Boolean(normalized) && UEN_PATTERN.test(normalized);
}

/**
 * Compare a possibly-masked proxy (mobile number or account) against the
 * configured values.
 *
 * Banks mask proxies as "****5678" or "•••• 1234". Only the visible tail can be
 * compared, so a short visible run is treated as unverifiable rather than as a
 * match - matching on one or two digits would accept almost any payee.
 *
 * Returns true, false, or null meaning "not enough information".
 */
function proxyMatches(rawProxy, candidates) {
  if (!rawProxy || !candidates.length) {
    return null;
  }

  const raw = String(rawProxy);
  const isMasked = MASK_CHARACTERS.test(raw);
  const visible = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

  if (!visible) {
    return null;
  }

  if (!isMasked) {
    return candidates.some(candidate => candidate === visible);
  }

  if (visible.length < 3) {
    return null;
  }

  return candidates.some(
    candidate => candidate.endsWith(visible) || candidate.includes(visible)
  );
}

/**
 * Decide whether the receipt was paid to us.
 *
 * UEN is checked first because it is an exact identifier that does not vary
 * between banks, unlike the display name.
 *
 * Returns { matched: true|false|null, reason }, where null means the receipt
 * did not show enough to tell - which flags for review rather than approving.
 */
function matchRecipient(extraction, rules) {
  const configuredUen = normalizeUen(rules.uen);
  // Something in the UEN field that isn't shaped like a UEN (an order code, a
  // bill reference) says nothing about the payee: fall through to the name.
  const rawExtractedUen = normalizeUen(extraction.recipient_uen);
  const extractedUen = isPlausibleUen(rawExtractedUen) ? rawExtractedUen : null;

  if (configuredUen && extractedUen) {
    return extractedUen === configuredUen
      ? { matched: true }
      : { matched: false, reason: REASONS.RECIPIENT_MISMATCH };
  }

  const acceptedNames = [...(rules.recipientNames || []), ...(rules.recipientAliases || [])]
    .map(normalizeRecipientName)
    .filter(Boolean);

  const extractedName = normalizeRecipientName(extraction.recipient_name);

  if (extractedName && acceptedNames.length) {
    const matched = acceptedNames.some(
      accepted => accepted === extractedName
        || extractedName.includes(accepted)
        || accepted.includes(extractedName)
    );

    if (matched) {
      return { matched: true };
    }

    // A name that is clearly present and clearly different is a real mismatch,
    // not merely unverifiable.
    return { matched: false, reason: REASONS.RECIPIENT_MISMATCH };
  }

  const proxyCandidates = [rules.proxyNumber, rules.uen]
    .map(normalizeUen)
    .filter(Boolean);

  const proxyResult = proxyMatches(extraction.recipient_proxy, proxyCandidates);

  if (proxyResult === true) {
    return { matched: true };
  }

  if (proxyResult === false) {
    return { matched: false, reason: REASONS.RECIPIENT_MISMATCH };
  }

  return { matched: null, reason: REASONS.RECIPIENT_UNVERIFIABLE };
}

/**
 * Resolve the transaction instant, preferring the structured fields and falling
 * back to the timestamp exactly as printed.
 */
function resolveTransactionTime(extraction) {
  const structured = sgtDateTimeToUtc(extraction.transaction_date, extraction.transaction_time);
  if (structured) {
    return structured;
  }

  return parseReceiptDateTime(extraction.transaction_datetime_text);
}

/**
 * Whether this order's own code (e.g. DG20261126-14) is printed on the
 * receipt. Our PayNow QR sets it as the bill reference, and banks show it as
 * "Reference number", "UEN/Bill Reference No." or similar.
 *
 * Exact match per token, never a substring: DG20261126-1 must not match a
 * receipt for DG20261126-14.
 */
function receiptShowsOrderCode(extraction, orderCode) {
  const wanted = normalizeReference(orderCode);
  if (!wanted) {
    return false;
  }

  return referenceTokens(extraction).includes(wanted);
}

// Our order codes: DG + yyyymmdd + "-" + n (see 0004_order_code.sql).
const ORDER_CODE_PATTERN = /^DG\d{8}\d+$/;

/** Every normalised reference-like token the receipt shows. */
function referenceTokens(extraction) {
  const tokens = [];
  for (const value of [extraction.bill_reference, extraction.reference_id, extraction.recipient_uen]) {
    if (!value) {
      continue;
    }
    const text = String(value);
    tokens.push(normalizeReference(text));
    text.split(/[\s,;:|()]+/).forEach(token => tokens.push(normalizeReference(token)));
  }
  return tokens.filter(Boolean);
}

/** Whether the receipt shows an order code that belongs to a DIFFERENT order. */
function receiptShowsOtherOrderCode(extraction, orderCode) {
  const own = normalizeReference(orderCode);
  return referenceTokens(extraction).some(token => ORDER_CODE_PATTERN.test(token) && token !== own);
}


// --- The decision ------------------------------------------------------------

/**
 * Evaluate a receipt against an order.
 *
 * Pure: no database, no clock, no network. `now` and `receivedAt` are passed in
 * so tests can pin them, and so the deadline is always judged on when the
 * customer SENT the screenshot rather than when verification happened to run.
 *
 * @param {object}  extraction   normalised Gemini output
 * @param {object}  order        { total_cents, created_at }
 * @param {object}  rules        config.payment
 * @param {Date}    now
 * @param {Date}    receivedAt   when the customer sent the screenshot
 * @param {object}  duplicate    { reference: bool, image: bool } from the DB
 * @param {number}  incompleteAttempts  prior incomplete attempts on this order
 * @param {number}  missingReferenceAttempts  prior "no reference shown" attempts on this order
 * @returns {{ outcome: string, reasons: string[], normalized: object }}
 */
function evaluatePayment({
  extraction,
  order,
  rules,
  now = new Date(),
  receivedAt = new Date(),
  duplicate = { reference: false, image: false },
  incompleteAttempts = 0,
  missingReferenceAttempts = 0,
}) {
  const reasons = new Set();

  // --- Is this even a receipt? ---
  if (extraction.is_bank_transfer_receipt === false) {
    reasons.add(REASONS.NOT_A_RECEIPT);
  }

  if (extraction.readability === 'unreadable') {
    reasons.add(REASONS.UNREADABLE);
  }

  // --- Did the transfer actually complete? ---
  // A "Review transfer" or "Scheduled" screen is the most common way someone
  // accidentally - or deliberately - submits a payment that never happened.
  const transferStatus = extraction.transfer_status || 'unknown';
  if (transferStatus !== 'successful') {
    reasons.add(REASONS.INCOMPLETE_TRANSFER);
  }

  // --- Tampering signals ---
  if (extraction.appears_edited_or_composited === true) {
    reasons.add(REASONS.SUSPECTED_EDIT);
  }

  // --- Amount ---
  const parsedAmount = extraction.amount_value !== null && extraction.amount_value !== undefined
    ? parseDisplayedAmount(String(extraction.amount_value))
    : parseDisplayedAmount(extraction.amount_text);

  const amountCents = parsedAmount.cents;
  const currency = parsedAmount.currency || extraction.currency || null;

  if (amountCents === null) {
    reasons.add(REASONS.AMOUNT_UNREADABLE);
  } else {
    // A foreign-currency receipt cannot be compared against an SGD total.
    const currencyOk = !currency || ['SGD'].includes(String(currency).toUpperCase());

    if (!currencyOk) {
      reasons.add(REASONS.AMOUNT_MISMATCH);
    } else if (amountCents < order.total_cents) {
      reasons.add(REASONS.AMOUNT_MISMATCH);
    } else if (amountCents > order.total_cents) {
      // Informational only: overpaying still covers the order, so it approves.
      reasons.add(REASONS.OVERPAID);
    }
  }

  // --- Timestamp ---
  const txnAt = truncateToMinute(resolveTransactionTime(extraction));
  const orderCodeShown = receiptShowsOrderCode(extraction, order.code);
  const txnDate = txnAt ? null : parseReceiptDate(extraction.transaction_date, extraction.transaction_datetime_text);
  // Date-only receipts are accepted on either this order's own code, or a
  // transaction reference the duplicate guard can hold onto - but never when
  // the receipt names a different order, i.e. was paid for something else.
  const dateOnlyBacking = orderCodeShown
    || (Boolean(normalizeReference(extraction.reference_id)) && !receiptShowsOtherOrderCode(extraction, order.code));

  if (!txnAt && txnDate && dateOnlyBacking) {
    // Date but no time (OCBC prints only "26 Nov 2026"). The time check exists
    // to stop recycled old receipts. A receipt carrying this order's own code
    // cannot predate the order - the code didn't exist yet. Without the code
    // (paid by typing the UEN), the bank's transaction ID is claimed by the
    // duplicate guard, so one payment can still only ever cover one order; the
    // remaining risk is an unsubmitted payment to us from earlier the same day,
    // which was accepted as a trade-off. The date has to fall between the day
    // the order was placed and the day the screenshot was sent.
    if (txnDate < sgtIsoDate(order.created_at)) {
      reasons.add(REASONS.TIMESTAMP_BEFORE_ORDER);
    }
    if (txnDate > sgtIsoDate(receivedAt)) {
      reasons.add(REASONS.TIMESTAMP_IN_FUTURE);
    }
  } else if (!txnAt) {
    reasons.add(REASONS.TIMESTAMP_UNREADABLE);
  } else {
    const skewMs = rules.clockSkewMinutes * 60 * 1000;
    const maxAgeMs = rules.maxAgeMinutes * 60 * 1000;
    const orderCreatedAt = new Date(order.created_at);

    if (txnAt.getTime() < orderCreatedAt.getTime() - skewMs) {
      // Paid before the order existed: almost always a recycled old receipt.
      reasons.add(REASONS.TIMESTAMP_BEFORE_ORDER);
    }

    if (txnAt.getTime() > receivedAt.getTime() + skewMs) {
      reasons.add(REASONS.TIMESTAMP_IN_FUTURE);
    }

    if (receivedAt.getTime() - txnAt.getTime() > maxAgeMs) {
      reasons.add(REASONS.TIMESTAMP_TOO_OLD);
    }
  }

  // --- Reference ---
  const referenceNormalized = normalizeReference(extraction.reference_id);

  if (!referenceNormalized) {
    // Usually the customer cropped it off or sent the wrong screen, so they are
    // asked to resend first. Some banks genuinely do not print one, so a
    // repeat reaches a human (see decideOutcome).
    reasons.add(REASONS.MISSING_REFERENCE);
  }

  // --- Recipient ---
  const recipient = matchRecipient(extraction, rules);
  if (recipient.reason) {
    reasons.add(recipient.reason);
  }

  // --- Cropping ---
  // Only fatal when it actually cost us a field we need; a cropped screenshot
  // that still shows everything is fine.
  const missingRequired =
    reasons.has(REASONS.AMOUNT_UNREADABLE)
    || reasons.has(REASONS.TIMESTAMP_UNREADABLE)
    || reasons.has(REASONS.MISSING_REFERENCE)
    || reasons.has(REASONS.RECIPIENT_UNVERIFIABLE);

  if (extraction.appears_cropped === true && missingRequired) {
    reasons.add(REASONS.CROPPED);
  }

  // --- Duplicates (decided by the database, reported here) ---
  if (duplicate.reference) {
    reasons.add(REASONS.DUPLICATE_REFERENCE);
  }
  if (duplicate.image) {
    reasons.add(REASONS.DUPLICATE_IMAGE);
  }

  const normalized = {
    amountCents,
    currency,
    txnAt,
    // Set only for a date-only receipt accepted on its order code.
    txnDate: txnAt ? null : txnDate,
    orderCodeShown,
    referenceNormalized,
    referenceRaw: extraction.reference_id || null,
    recipientName: extraction.recipient_name || null,
    recipientUen: extraction.recipient_uen || null,
    recipientProxy: extraction.recipient_proxy || null,
    transferStatus,
    bankApp: extraction.bank_app || null,
    txnText: extraction.transaction_datetime_text || null,
  };

  return {
    outcome: decideOutcome(reasons, incompleteAttempts, rules, missingReferenceAttempts),
    reasons: [...reasons].sort(),
    normalized,
  };
}

// How many "no reference shown" screenshots an order gets before the next one
// goes to an admin, when MAX_MISSING_REFERENCE_ATTEMPTS isn't set.
const DEFAULT_MAX_MISSING_REFERENCE_ATTEMPTS = 2;

function maxMissingReferenceAttempts(rules) {
  const configured = rules && rules.maxMissingReferenceAttempts;
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_MISSING_REFERENCE_ATTEMPTS;
}

/**
 * Apply outcome precedence. Order matters: the most specific customer-fixable
 * problem wins, so someone who sent a "Review transfer" screen is told exactly
 * that instead of a generic "under review".
 */
function decideOutcome(reasons, incompleteAttempts, rules, missingReferenceAttempts = 0) {
  if (reasons.has(REASONS.NOT_A_RECEIPT) || reasons.has(REASONS.UNREADABLE)) {
    return OUTCOMES.FLAGGED;
  }

  if (reasons.has(REASONS.INCOMPLETE_TRANSFER)) {
    // Repeatedly sending unfinished transfers stops being an honest mistake.
    return incompleteAttempts + 1 >= rules.maxIncompleteAttempts
      ? OUTCOMES.FLAGGED
      : OUTCOMES.INCOMPLETE_TRANSFER;
  }

  if (reasons.has(REASONS.DUPLICATE_REFERENCE) || reasons.has(REASONS.DUPLICATE_IMAGE)) {
    return OUTCOMES.DUPLICATE_REJECTED;
  }

  const flagging = [
    REASONS.MISSING_REFERENCE,
    REASONS.RECIPIENT_MISMATCH,
    REASONS.RECIPIENT_UNVERIFIABLE,
    REASONS.AMOUNT_MISMATCH,
    REASONS.AMOUNT_UNREADABLE,
    REASONS.TIMESTAMP_TOO_OLD,
    REASONS.TIMESTAMP_IN_FUTURE,
    REASONS.TIMESTAMP_BEFORE_ORDER,
    REASONS.TIMESTAMP_UNREADABLE,
    REASONS.SUSPECTED_EDIT,
    REASONS.CROPPED,
  ];

  const flaggedBy = flagging.filter(reason => reasons.has(reason));

  if (!flaggedBy.length) {
    return OUTCOMES.AUTO_APPROVED;
  }

  // The reference is the only thing wrong (CROPPED here can only mean the crop
  // is what hid it): the customer can fix that themselves, the same way a
  // repeat screenshot is handed back to them. Anything else still needs a
  // human. Repeats go to an admin, since some banks don't print a reference.
  const onlyReferenceMissing = flaggedBy.every(
    reason => reason === REASONS.MISSING_REFERENCE || reason === REASONS.CROPPED
  );

  if (onlyReferenceMissing) {
    return missingReferenceAttempts + 1 >= maxMissingReferenceAttempts(rules)
      ? OUTCOMES.FLAGGED
      : OUTCOMES.MISSING_REFERENCE;
  }

  return OUTCOMES.FLAGGED;
}

module.exports = {
  OUTCOMES,
  REASONS,
  evaluatePayment,
  decideOutcome,
  maxMissingReferenceAttempts,
  normalizeReference,
  normalizeRecipientName,
  normalizeUen,
  proxyMatches,
  matchRecipient,
  resolveTransactionTime,
};
