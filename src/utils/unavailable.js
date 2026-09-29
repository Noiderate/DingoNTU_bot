/**
 * Whether an error means a data source we depend on is having a moment (Google
 * Sheets for the halls, the database for the menu), as opposed to a real bug.
 *
 * Handlers use it to tell the customer to retry, keep their cart, and skip
 * posting anything half-built - see googleSheets.readSheetValues and
 * menuStore.guarded, which tag the errors this recognises.
 */
function isTemporarilyUnavailable(error) {
  return Boolean(error)
    && (error.code === 'SHEETS_UNAVAILABLE' || error.code === 'MENU_UNAVAILABLE');
}

module.exports = { isTemporarilyUnavailable };
