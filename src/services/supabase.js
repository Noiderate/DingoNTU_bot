const { createClient } = require('@supabase/supabase-js');
const { config, assertRequiredConfig } = require('../config');

// Held at module scope so a warm serverless invocation reuses the connection
// pool. Built lazily rather than at require() time so that importing this file
// never throws: endpoints such as /api/health must still be able to load and
// report which variables are missing.
let client = null;

function getSupabase() {
  if (client) {
    return client;
  }

  assertRequiredConfig(['supabase']);

  client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
      // There is no end user session here; this is a trusted server-side client
      // using the service role key.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}

/**
 * Postgres unique-violation. Used by the payment replay guard, where a
 * duplicate reference is an expected outcome rather than a failure.
 */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error) {
  return Boolean(error) && error.code === UNIQUE_VIOLATION;
}

/**
 * Unwraps a supabase-js `{ data, error }` result, throwing on error.
 *
 * supabase-js does not throw by itself, so without this every call site would
 * need its own error check and a forgotten one would silently continue with
 * `data === null`.
 */
function unwrap(result, context) {
  if (result.error) {
    const error = new Error(`${context}: ${result.error.message}`);
    error.cause = result.error;
    error.code = result.error.code;
    throw error;
  }

  return result.data;
}

module.exports = {
  getSupabase,
  unwrap,
  isUniqueViolation,
  UNIQUE_VIOLATION,
};
