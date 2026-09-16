const { google } = require('googleapis');
require('dotenv').config();

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

/**
 * Ensure the Orders sheet has header row
 */
async function ensureOrdersHeaders() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Orders!A1:K1',
    });

    const existingHeaders = (response.data.values || [])[0] || [];
    if (existingHeaders.length > 0) return; // Headers already present

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Orders!A1:K1',
      valueInputOption: 'RAW',
      resource: {
        values: [[
          'Timestamp',
          'Order ID',
          'Status',
          'User ID',
          'User Name',
          'Username',
          'Hall',
          'Items',
          'Total',
          'Admin ID',
          'Processed At',
        ]],
      },
    });

    console.log('✓ Orders sheet headers written');
  } catch (error) {
    console.error('Error ensuring Orders sheet headers:', error.message);
  }
}

/**
 * Initialize Google Sheets and load admin IDs
 */
async function initializeGoogleSheets() {
  try {
    adminIds = await readAdminIds();
    await ensureOrdersHeaders();
    console.log(`✓ Google Sheets initialized. Loaded ${adminIds.length} admin(s)`);
    return true;
  } catch (error) {
    console.error('✗ Failed to initialize Google Sheets:', error.message);
    return false;
  }
}

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

/**
 * Check if a user is an admin
 */
function isAdmin(userId) {
  return adminIds.includes(userId);
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
 * Read data from a sheet range
 */
async function readFromSheet(range) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return response.data.values || [];
  } catch (error) {
    console.error('Error reading from sheet:', error.message);
    return [];
  }
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

    const values = response.data.values || [];
    
    // Parse food items: Name, Price, Stock
    return values
      .filter(row => row && row[0]) // Filter empty rows
      .map((row, index) => ({
        id: index + 2, // Row number (starting from 2)
        name: row[0] || '',
        price: parseFloat(row[1]) || 0,
        stock: parseFloat(row[2]) || 0,
      }));
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

    const values = response.data.values || [];
    
    // Parse hall names and short names
    return values
      .filter(row => row && row[0]) // Filter empty rows
      .map((row, index) => ({
        id: index + 2, // Row number (starting from 2)
        name: row[0] || '',
        shortName: row[1] || row[0] || '',
      }));
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
 * Log an order decision (confirmed/rejected) to Orders sheet
 */
async function logOrderAction(order, status, adminId) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const range = 'Orders!A2:K';

    const itemsSummary = (order.items || [])
      .map(item => `${item.name} x${item.quantity}`)
      .join(', ');

    const resource = {
      values: [[
        new Date().toISOString(),
        order.id,
        status,
        order.userId,
        order.userName || '',
        order.username ? `@${order.username}` : '',
        order.hallName || '',
        itemsSummary,
        Number(order.total || 0).toFixed(2),
        adminId,
        order.processedAt || '',
      ]],
    };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });

    return { success: true };
  } catch (error) {
    console.error('Error logging order action:', error.message);
    return { success: false, message: error.message };
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
  initializeGoogleSheets,
  readAdminIds,
  isAdmin,
  getAdminIds,
  reloadAdminIds,
  appendToSheet,
  writeToSheet,
  readFromSheet,
  addAdmin,
  deleteAdmin,
  getFoodItems,
  addFoodItem,
  deleteFoodItem,
  updateFoodItemStock,
  updateFoodItemStocksBatch,
  getHalls,
  addHall,
  deleteHall,
  logOrderAction,
  getPreorderAdminTag,
  getAdminUsernameById,
};