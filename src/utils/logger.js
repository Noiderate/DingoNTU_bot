/**
 * Single-line JSON logging, so Vercel's runtime log search can filter on a
 * field rather than on substrings of prose.
 *
 * PDPA: never log personal data. That means no full names, phone numbers,
 * addresses, bank references or raw model output. Log identifiers - order code,
 * submission id, update id - and reason codes instead, which are enough to
 * trace an incident without turning the log into a data store.
 */

const REDACTED_KEYS = [
  'token', 'key', 'secret', 'password', 'authorization',
  'private_key', 'apikey', 'api_key',
  'phone', 'contact_number', 'address', 'postal_code',
  'raw_extraction', 'recipient_name', 'reference',
];

function redact(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (typeof value === 'object') {
    const output = {};

    for (const [key, entry] of Object.entries(value)) {
      const isSensitive = REDACTED_KEYS.some(needle => key.toLowerCase().includes(needle));
      output[key] = isSensitive ? '[redacted]' : redact(entry);
    }

    return output;
  }

  return value;
}

function log(level, event, fields = {}) {
  const line = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...redact(fields),
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = { log, redact };
