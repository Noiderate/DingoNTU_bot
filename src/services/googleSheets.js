const { google } = require('googleapis');
// Load both local environment files before reading process.env directly.
require('../config');
const stateStore = require('./stateStore');
const { log } = require('../utils/logger');

// Initialize Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL || '',
    private_key: (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// Store admin IDs globally
let adminIds = [];

// The Orders tab's headers and row writes are owned by src/services/sheetMirror.js,
// which manages the full 18-column layout. The old 11-column header writer and
// the append-per-action logger that used to live here were removed: both
// predate the one-row-per-order mirror and would corrupt it if called.

/**
 * Read admin IDs from Settings sheet
 */
async function readAdminIds() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'Settings!A2:A'; // Start from A2 (skip header)

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const values = response.data.values || [];
    // Filter out empty rows and headers, convert to numbers
    return values
      .map(row => parseInt(row[0]))
      .filter(id => !isNaN(id) && id > 0);
  } catch (error) {
    console.error('Error reading admin IDs:', error.message);
    return [];
  }
}

// Admin ids used to be loaded once by a startup routine. Serverless has no
// reliable startup, so they are loaded on first use and cached for the life of
// the warm instance. The TTL bounds how long a newly added admin waits, without
// re-reading the sheet on every single update.
let adminIdsLoadedAt = 0;
const ADMIN_CACHE_TTL_MS = 60 * 1000;

/**
 * Ensure the admin list is populated before any isAdmin() check.
 *
 * isAdmin() itself stays synchronous because it is called from inside
 * non-async code paths; this is awaited once per update instead.
 */
async function ensureAdminIdsLoaded({ force = false } = {}) {
  const isStale = Date.now() - adminIdsLoadedAt > ADMIN_CACHE_TTL_MS;

  if (!force && adminIds.length > 0 && !isStale) {
    return adminIds;
  }

  try {
    const loaded = await readAdminIds();

    // An empty read is treated as a transient failure rather than "everyone
    // lost admin": a Sheets blip must not lock every admin out of the bot.
    if (loaded.length > 0 || adminIds.length === 0) {
      adminIds = loaded;
    }

    adminIdsLoadedAt = Date.now();
  } catch (error) {
    console.error('Error loading admin IDs:', error.message);
  }

  return adminIds;
}

/**
 * Check if a user is an admin
 */
function isAdmin(userId) {
  return adminIds.includes(Number(userId));
}

/**
 * Get all admin IDs
 */
function getAdminIds() {
  return [...adminIds];
}

/**
 * Reload admin IDs from Google Sheets
 */
async function reloadAdminIds() {
  try {
    adminIds = await readAdminIds();
    console.log(`✓ Admin IDs reloaded. Total admins: ${adminIds.length}`);
    return true;
  } catch (error) {
    console.error('Error reloading admin IDs:', error.message);
    return false;
  }
}

/**
 * Append data to a sheet
 */
async function appendToSheet(sheetName, values) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = `${sheetName}!A:A`;

    const resource = {
      values: [values],
    };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });

    return true;
  } catch (error) {
    console.error(`Error appending to sheet "${sheetName}":`, error.message);
    return false;
  }
}

/**
 * Write data to a specific range in a sheet
 */
async function writeToSheet(range, values) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    const resource = {
      values,
    };

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });

    return true;
  } catch (error) {
    console.error('Error writing to sheet:', error.message);
    return false;
  }
}

/**
 * Clear a range's values (not its formatting).
 */
async function clearRange(range) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    await sheets.spreadsheets.values.clear({ spreadsheetId, range });
    return true;
  } catch (error) {
    console.error('Error clearing sheet range:', error.message);
    return false;
  }
}

/**
 * Look up a tab's numeric sheetId by title, creating the tab if it doesn't
 * exist yet. Callers that only write values (A1-notation ranges) don't need
 * this, but formatting requests address a sheet by its numeric id, not title.
 *
 * Errors are allowed to throw, unlike most functions in this file: a caller
 * that can't resolve or create the tab has nowhere safe to write, so
 * swallowing the error and returning something falsy would just move the
 * failure somewhere more confusing.
 */
async function ensureSheetTab(title) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });

  const existing = (meta.data.sheets || []).find(s => s.properties.title === title);
  if (existing) {
    return existing.properties.sheetId;
  }

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ addSheet: { properties: { title } } }] },
  });

  return response.data.replies[0].addSheet.properties.sheetId;
}

/**
 * Apply formatting/structure requests (bold ranges, freeze rows, etc) to the
 * spreadsheet. Cosmetic only - callers should treat a failure here as
 * non-fatal, since the underlying data write already succeeded by the time
 * this runs.
 */
async function batchUpdateSpreadsheet(requests) {
  if (!requests || !requests.length) {
    return;
  }

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
}

/**
 * Read data from a sheet range
 */
async function readFromSheet(range) {
  try {
    return await readFromSheetOrThrow(range);
  } catch (error) {
    console.error('Error reading from sheet:', error.message);
    return [];
  }
}

/**
 * Like readFromSheet, but throws instead of returning [] on failure.
 *
 * readFromSheet's [] on error is indistinguishable from a genuinely empty
 * range, which is fine for callers that treat both the same - but wrong for
 * callers like sheetMirror.js's duplicate-row detection, where mistaking a
 * transient read failure for "no existing row" causes a real duplicate to be
 * appended.
 */
async function readFromSheetOrThrow(range) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  return response.data.values || [];
}

/**
 * Add a new admin to Google Sheets
 */
async function addAdmin(newAdminId) {
  try {
    // Check if already an admin
    if (isAdmin(newAdminId)) {
      return { success: false, message: 'User is already an admin.' };
    }

    // Add to Google Sheets
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'Settings!A2:A'; // Start from A2 (skip header)

    const resource = {
      values: [[newAdminId]],
    };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });

    // Update local cache
    adminIds.push(newAdminId);
    console.log(`✓ Admin added: ${newAdminId}`);
    return { success: true, message: `✓ Admin ${newAdminId} added successfully.` };
  } catch (error) {
    console.error('Error adding admin:', error.message);
    return { success: false, message: `✗ Failed to add admin: ${error.message}` };
  }
}

/**
 * Remove an admin from Google Sheets
 */
async function deleteAdmin(adminIdToDelete) {
  try {
    // Check if admin exists
    if (!isAdmin(adminIdToDelete)) {
      return { success: false, message: 'User is not an admin.' };
    }

    // Remove from local cache
    adminIds = adminIds.filter(id => id !== adminIdToDelete);

    // Clear the range starting from A2 and rewrite
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    // First, clear the range from A2 onwards
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Settings!A2:A',
    });

    // Then write the updated list starting from A2
    const values = adminIds.map(id => [id]);
    const resource = {
      values,
    };

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Settings!A2',
      valueInputOption: 'RAW',
      resource,
    });

    console.log(`✓ Admin removed: ${adminIdToDelete}`);
    return { success: true, message: `✓ Admin ${adminIdToDelete} removed successfully.` };
  } catch (error) {
    console.error('Error deleting admin:', error.message);
    return { success: false, message: `✗ Failed to delete admin: ${error.message}` };
  }
}

/**
 * Parse FoodAndStock!A2:C rows into food items.
 *
 * The row number is computed BEFORE filtering - a blank row anywhere in the
 * middle must not shift every later item's id, or stock updates end up
 * writing to the wrong physical row (see MAINTENANCE.md).
 */
function parseFoodItemRows(values) {
  return values
    .map((row, index) => ({ row, id: index + 2 })) // Row number (starting from 2)
    .filter(({ row }) => row && row[0]) // Filter empty rows
    .map(({ row, id }) => ({
      id,
      name: row[0] || '',
      price: parseFloat(row[1]) || 0,
      stock: parseFloat(row[2]) || 0,
    }));
}

/**
 * Read all food items from FoodAndStock sheet
 */
async function getFoodItems() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'FoodAndStock!A2:C'; // Start from A2 (skip header)

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return parseFoodItemRows(response.data.values || []);
  } catch (error) {
    console.error('Error reading food items:', error.message);
    return [];
  }
}

/**
 * Add a new food item to FoodAndStock sheet
 */
async function addFoodItem(name, price) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'FoodAndStock!A2:B';

    const resource = {
      values: [[name, price]],
    };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });

    console.log(`✓ Food item added: ${name}`);
    return { success: true, message: `✓ Food item "${name}" ($${price}) added successfully.` };
  } catch (error) {
    console.error('Error adding food item:', error.message);
    return { success: false, message: `✗ Failed to add food item: ${error.message}` };
  }
}

/**
 * Delete a food item from FoodAndStock sheet
 */
async function deleteFoodItem(rowId) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    // Read all food items
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'FoodAndStock!A2:C',
    });

    let foodItems = response.data.values || [];
    
    // Calculate the index in the array (rowId is the actual sheet row number)
    const itemIndex = rowId - 2; // Convert row number to array index
    
    // Remove the item at the specified index
    if (itemIndex >= 0 && itemIndex < foodItems.length) {
      foodItems.splice(itemIndex, 1);
    } else {
      throw new Error(`Food item at row ${rowId} not found`);
    }

    // Clear the entire range
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'FoodAndStock!A2:C',
    });

    // Rewrite the remaining items
    if (foodItems.length > 0) {
      const resource = {
        values: foodItems,
      };

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'FoodAndStock!A2',
        valueInputOption: 'RAW',
        resource,
      });
    }

    console.log(`✓ Food item deleted: Row ${rowId}`);
    return { success: true, message: `✓ Food item deleted successfully.` };
  } catch (error) {
    console.error('Error deleting food item:', error.message);
    return { success: false, message: `✗ Failed to delete food item: ${error.message}` };
  }
}

/**
 * Update stock for a specific food item
 */
async function updateFoodItemStock(rowId, newStock) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    
    // Get the food item name to display confirmation
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `FoodAndStock!A${rowId}:A${rowId}`,
    });
    
    const values = response.data.values || [];
    const itemName = values[0] ? values[0][0] : 'Unknown';
    
    // Update the stock (column C)
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `FoodAndStock!C${rowId}`,
      valueInputOption: 'RAW',
      resource: {
        values: [[newStock]],
      },
    });

    console.log(`✓ Stock updated for ${itemName}: ${newStock}`);

    // Only a manual admin edit reaches this function - order-driven
    // deduct/restock goes through updateFoodItemStocksBatch instead - so this
    // is the one place that should move the "what Reset Halls and Orders
    // restores to" baseline.
    try {
      await stateStore.update(stateStore.KEYS.stockBaselines(), current => ({
        ...(current || {}),
        [itemName]: newStock,
      }));
    } catch (error) {
      log('warn', 'stock_baseline_update_failed', { item: itemName, error: error.message });
    }

    return { success: true, message: `✓ Stock updated for "${itemName}" to ${newStock}.` };
  } catch (error) {
    console.error('Error updating food stock:', error.message);
    return { success: false, message: `✗ Failed to update stock: ${error.message}` };
  }
}

/**
 * Update stock for multiple food items in one batch request
 */
async function updateFoodItemStocksBatch(stockUpdates) {
  try {
    if (!Array.isArray(stockUpdates) || stockUpdates.length === 0) {
      return { success: true };
    }

    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    const data = stockUpdates.map(update => ({
      range: `FoodAndStock!C${update.rowId}`,
      values: [[update.newStock]],
    }));

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: 'RAW',
        data,
      },
    });

    console.log(`✓ Batch stock updated for ${stockUpdates.length} item(s)`);
    return { success: true };
  } catch (error) {
    console.error('Error updating food stocks in batch:', error.message);
    return { success: false, message: `✗ Failed to update food stocks: ${error.message}` };
  }
}

/**
 * Parse Hall!A2:B rows into halls. Row number computed before filtering -
 * see parseFoodItemRows() above for why.
 */
function parseHallRows(values) {
  return values
    .map((row, index) => ({ row, id: index + 2 })) // Row number (starting from 2)
    .filter(({ row }) => row && row[0]) // Filter empty rows
    .map(({ row, id }) => ({
      id,
      name: row[0] || '',
      shortName: row[1] || row[0] || '',
    }));
}

/**
 * Read all halls from Hall sheet
 */
async function getHalls() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'Hall!A2:B'; // Start from A2 (skip header)

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return parseHallRows(response.data.values || []);
  } catch (error) {
    console.error('Error reading halls:', error.message);
    return [];
  }
}

/**
 * Add a hall to Hall sheet
 */
async function addHall(name) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'Hall!A2:A';

    const resource = {
      values: [[name]],
    };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });

    console.log(`✓ Hall added: ${name}`);
    return { success: true, message: `✓ Hall "${name}" added successfully.` };
  } catch (error) {
    console.error('Error adding hall:', error.message);
    return { success: false, message: `✗ Failed to add hall: ${error.message}` };
  }
}

/**
 * Delete a hall from Hall sheet
 */
async function deleteHall(rowId) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    // Read all halls
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Hall!A2:A',
    });

    let halls = response.data.values || [];
    
    // Calculate the index in the array (rowId is the actual sheet row number)
    const itemIndex = rowId - 2; // Convert row number to array index
    
    // Remove the item at the specified index
    if (itemIndex >= 0 && itemIndex < halls.length) {
      halls.splice(itemIndex, 1);
    } else {
      throw new Error(`Hall at row ${rowId} not found`);
    }

    // Clear the entire range
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Hall!A2:A',
    });

    // Rewrite the remaining items
    if (halls.length > 0) {
      const resource = {
        values: halls,
      };

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Hall!A2',
        valueInputOption: 'RAW',
        resource,
      });
    }

    console.log(`✓ Hall deleted: Row ${rowId}`);
    return { success: true, message: `✓ Hall deleted successfully.` };
  } catch (error) {
    console.error('Error deleting hall:', error.message);
    return { success: false, message: `✗ Failed to delete hall: ${error.message}` };
  }
}

/**
 * Get the admin ID to tag in preorder message from Settings sheet B2
 */
async function getPreorderAdminTag() {
  try {
    const values = await readFromSheet('Settings!B2');
    if (values && values.length > 0 && values[0].length > 0) {
      const adminId = parseInt(values[0][0]);
      if (!isNaN(adminId) && adminId > 0) {
        return adminId;
      }
    }
    return null;
  } catch (error) {
    console.error('Error reading preorder admin tag:', error.message);
    return null;
  }
}

/**
 * Get the admin username by ID from Telegram
 */
async function getAdminUsernameById(bot, adminId) {
  try {
    const chat = await bot.getChat(adminId);
    return chat.username || null;
  } catch (error) {
    console.error('Error fetching admin username:', error.message);
    return null;
  }
}

module.exports = {
  readAdminIds,
  ensureAdminIdsLoaded,
  isAdmin,
  getAdminIds,
  reloadAdminIds,
  appendToSheet,
  writeToSheet,
  clearRange,
  ensureSheetTab,
  batchUpdateSpreadsheet,
  readFromSheet,
  readFromSheetOrThrow,
  addAdmin,
  deleteAdmin,
  getFoodItems,
  parseFoodItemRows,
  addFoodItem,
  deleteFoodItem,
  updateFoodItemStock,
  updateFoodItemStocksBatch,
  getHalls,
  parseHallRows,
  addHall,
  deleteHall,
  getPreorderAdminTag,
  getAdminUsernameById,
};
