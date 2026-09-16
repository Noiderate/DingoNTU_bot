/**
 * Main admin menu text
 */
function mainMenuText() {
  return `👑 Admin Menu`;
}

/**
 * Settings menu text
 */
function settingsMenuText() {
  return `⚙️ Settings Menu`;
}

/**
 * Admin stats text
 */
function adminStatsText(adminCount) {
  return `📊 Bot Statistics:\n\nAdmins loaded: ${adminCount}`;
}

/**
 * Reload success/fail text
 */
function reloadText(success) {
  return success ? '✓ Settings reloaded successfully!' : '✗ Failed to reload settings.';
}

/**
 * Manage admins text
 */
function manageAdminsText(userId, adminList, currentAdminTagId, currentAdminTagUsername) {
  const userIdDisplay = `[${userId}]`;
  const tagDisplay = currentAdminTagUsername 
    ? `@${currentAdminTagUsername} [${currentAdminTagId}]`
    : currentAdminTagId 
    ? `[${currentAdminTagId}]`
    : 'Not set';
  return `👥 Manage Admins\n\nYour ID: ${userIdDisplay}\n\nAdmin to tag in preorder: ${tagDisplay}\n\nCurrent admins:\n${adminList}`;
}

/**
 * Add admin prompt text
 */
function addAdminPromptText() {
  return `➕ Add Admin\n\nReply with the Telegram ID of the user you want to add as admin.\n\nExample: 123456789`;
}

/**
 * Delete admin selection text
 */
function deleteAdminSelectText() {
  return `➖ Delete Admin\n\nClick on an admin to delete:`;
}

/**
 * Manage food items text
 */
function manageFoodItemsText(foodItems) {
  let text = `🍔 Manage Food Items\n\n`;
  
  if (foodItems.length === 0) {
    text += 'No food items yet.';
  } else {
    text += 'Current items:\n';
    foodItems.forEach(item => {
      text += `• ${item.name} - $${item.price} (Stock: ${item.stock || 0})\n`;
    });
  }
  
  return text;
}

/**
 * Delete food item selection text
 */
function deleteFoodSelectText() {
  return `➖ Delete Food Item\n\nClick on a food item to delete:`;
}

/**
 * No food items text
 */
function noFoodItemsText() {
  return 'No food items to delete.';
}

/**
 * Add food item prompt text
 */
function addFoodItemPromptText() {
  return `➕ Add Food Item\n\nSend food item in format:\nname, price\n\nExample:\nChicken Burger, 5.99`;
}

/**
 * Edit specific stock selection text
 */
function editSpecificStockText() {
  return `📊 Edit Specific Stock\n\nClick on a food item to edit its stock:`;
}

/**
 * Edit specific stock prompt text
 */
function editStockPromptText(itemName, currentStock, currentIndex, totalItems) {
  return `📊 Enter stock for: ${itemName}\n(Current stock: ${currentStock || 0})\n\n${currentIndex} of ${totalItems}`;
}

/**
 * Edit all stock starting text
 */
function editAllStockStartText(foodItems) {
  let text = `📊 Edit All Stock\n\nCurrent stock levels:\n`;
  foodItems.forEach(item => {
    text += `• ${item.name}: ${item.stock || 0}\n`;
  });
  return text;
}

/**
 * Update complete text
 */
function updateCompleteText(count) {
  return `✓ Updated all ${count} food item(s)`;
}

/**
 * Manage halls text
 */
function manageHallsText(halls) {
  let text = `🏢 Manage Halls\n\n`;
  
  if (halls.length === 0) {
    text += 'No halls yet.';
  } else {
    text += 'Current halls:\n';
    halls.forEach(hall => {
      text += `• ${hall.name}\n`;
    });
  }
  
  return text;
}

/**
 * Add hall prompt text
 */
function addHallPromptText() {
  return `➕ Add Hall\n\nReply with the name of the hall.\n\nExample: Main Hall`;
}

/**
 * Delete hall selection text
 */
function deleteHallSelectText() {
  return `➖ Delete Hall\n\nClick on a hall to delete:`;
}

/**
 * Delivery mode menu text — lists halls with orders grouped underneath
 */
function deliveryModeText(halls, orders, foodItems = []) {
  const remainingStockItems = (foodItems || []).filter(item => (item.stock || 0) > 0);
  let stockSection = '📦 Remaining Stock\n';

  if (remainingStockItems.length === 0) {
    stockSection += '• No stock remaining';
  } else {
    remainingStockItems.forEach(item => {
      stockSection += `\n• ${item.name}: ${item.stock || 0}`;
    });
  }

  if (halls.length === 0) {
    return `🚚 Delivery Mode\n\n${stockSection}\n\nNo halls available.`;
  }

  const hallsWithOrders = halls
    .map(hall => ({
      hall,
      hallOrders: (orders || []).filter(order => order.hallName === hall.name),
    }))
    .filter(({ hallOrders }) => hallOrders.length > 0);

  if (hallsWithOrders.length === 0) {
    return `🚚 Delivery Mode\n\n${stockSection}\n\nNo active orders.`;
  }

  const sections = hallsWithOrders.map(({ hall, hallOrders }) => {
    let section = `🏢 ${hall.name}`;

    hallOrders.forEach(order => {
      const handle = order.username
        ? `@${order.username}`
        : order.userName || `User ${order.userId}`;
      const items = (order.items || [])
        .map(i => `${i.name} x${i.quantity}`)
        .join(', ');
      const payStatus = order.status === 'paid' ? 'paid' : 'unpaid';
      section += `\n  ${handle} - ${items} (${payStatus})`;
    });

    return section;
  });

  return `🚚 Delivery Mode\n\n${stockSection}\n\n${sections.join('\n\n\n')}`;
}

/**
 * Set admin to tag selection text
 */
function setAdminToTagText(currentAdminTagId, currentAdminTagUsername) {
  const currentDisplay = currentAdminTagUsername 
    ? `@${currentAdminTagUsername} [${currentAdminTagId}]`
    : currentAdminTagId 
    ? `[${currentAdminTagId}]`
    : 'Not set';
  return `🏷️ Set Admin to Tag\n\nCurrent admin to tag in preorder messages: ${currentDisplay}\n\nSelect a new admin to tag:`;
}

module.exports = {
  mainMenuText,
  settingsMenuText,
  adminStatsText,
  reloadText,
  manageAdminsText,
  addAdminPromptText,
  deleteAdminSelectText,
  setAdminToTagText,
  manageFoodItemsText,
  deleteFoodSelectText,
  noFoodItemsText,
  addFoodItemPromptText,
  editSpecificStockText,
  editStockPromptText,
  editAllStockStartText,
  updateCompleteText,
  manageHallsText,
  addHallPromptText,
  deleteHallSelectText,
  deliveryModeText,
};
