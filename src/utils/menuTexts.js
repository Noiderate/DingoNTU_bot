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
 * Spam orders menu text
 */
function spamOrdersText() {
  return '🧪 Spam Orders\n\n'
    + 'Creates fake PAID orders spread evenly across every hall, using random items from the current menu. '
    + 'Stock is deducted like real orders (it stops early if the menu runs out).\n\n'
    + 'Remove spam orders rejects the ones still open and puts their stock back. '
    + 'Orders are never deleted (the history is a permanent audit trail), so they stay in the Google Sheet as Rejected.';
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
 * Edit price selection text
 */
function editPriceListText() {
  return `💲 Edit Price\n\nClick on a food item to change its price:`;
}

/**
 * Edit price prompt text
 */
function editPricePromptText(itemName, currentPrice) {
  return `💲 Enter the new price for: ${itemName}\n(Current price: $${Number(currentPrice).toFixed(2)})\n\n`
    + `Reply with a number, e.g. 5.99`;
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
 * The get-ready/coming posts are automatic now, so there is no button to tap
 * while one is pending - this line is what tells the admin the menu isn't
 * stuck, and how close it is.
 */
function gatingStageLine({ mode, gatingHall, gatingProgress } = {}) {
  if (!gatingHall || !gatingProgress) {
    return null;
  }

  const label = mode === 'get-ready' ? 'Get ready' : 'we are coming';
  const target = mode === 'get-ready' ? '2/3' : 'all';
  const { served, total } = gatingProgress;

  return `⏳ Auto-posting "${label}" for the next hall once ${target} of `
    + `${gatingHall.name} is served (${served}/${total} so far).`;
}

// Telegram rejects messages over 4096 characters - and a rejected edit or
// send leaves the admin with no delivery menu at all. Kept under that with
// room to spare for the header and stock sections.
const DELIVERY_MENU_MAX_LENGTH = 3900;

function formatDeliveryOrderLine(order) {
  const handle = order.username
    ? `@${order.username}`
    : order.userName || `User ${order.userId}`;
  const items = (order.items || [])
    .map(i => `${i.name} x${i.quantity}`)
    .join(', ');
  const payStatus = order.status === 'paid' ? 'paid' : 'unpaid';
  return `  ${handle} - ${items} (${payStatus})`;
}

function hallSummaryLine(hall, hallOrders) {
  const paid = hallOrders.filter(order => order.status === 'paid').length;
  return `🏢 ${hall.name}: ${hallOrders.length} order(s) - ${paid} paid, ${hallOrders.length - paid} unpaid`;
}

/**
 * Detailed section for one hall, listing as many orders as fit in `budget`
 * characters and summarising the rest as "…and N more".
 */
function detailedHallSection(hall, hallOrders, budget = Infinity) {
  let section = `🏢 ${hall.name}`;

  for (let index = 0; index < hallOrders.length; index += 1) {
    const line = `\n${formatDeliveryOrderLine(hallOrders[index])}`;
    const remaining = hallOrders.length - index - 1;
    const moreNote = remaining > 0 ? `\n  …and ${remaining} more` : '';

    if (section.length + line.length + moreNote.length > budget) {
      return `${section}\n  …and ${hallOrders.length - index} more`;
    }

    section += line;
  }

  return section;
}

/**
 * Delivery mode menu text — lists halls with orders grouped underneath.
 *
 * On a busy night every order no longer fits in one Telegram message, so it
 * falls back to one summary line per hall, keeping the full list only for
 * the hall being served or up next (and trimming even that if needed).
 */
function deliveryModeText(halls, orders, foodItems = [], stage = {}) {
  const remainingStockItems = (foodItems || []).filter(item => (item.stock || 0) > 0);
  let stockSection = '📦 Remaining Stock\n';

  if (remainingStockItems.length === 0) {
    stockSection += '• No stock remaining';
  } else {
    remainingStockItems.forEach(item => {
      stockSection += `\n• ${item.name}: ${item.stock || 0}`;
    });
  }

  const gatingLine = gatingStageLine(stage);
  const sections = [stockSection, ...[gatingLine].filter(Boolean)];

  if (halls.length === 0) {
    return `🚚 Delivery Mode\n\n${sections.join('\n\n')}\n\nNo halls available.`;
  }

  const hallsWithOrders = halls
    .map(hall => ({
      hall,
      hallOrders: (orders || []).filter(order => order.hallName === hall.name),
    }))
    .filter(({ hallOrders }) => hallOrders.length > 0);

  if (hallsWithOrders.length === 0) {
    return `🚚 Delivery Mode\n\n${sections.join('\n\n')}\n\nNo active orders.`;
  }

  const header = `🚚 Delivery Mode\n\n${sections.join('\n\n')}\n\n`;

  const full = header + hallsWithOrders
    .map(({ hall, hallOrders }) => detailedHallSection(hall, hallOrders))
    .join('\n\n\n');

  if (full.length <= DELIVERY_MENU_MAX_LENGTH) {
    return full;
  }

  // While a hall is being served the sequencer already points at the NEXT
  // hall's get-ready/coming - the one being served is the gating hall.
  const focusHall = stage.gatingHall || stage.nextHallToPost;
  const focusName = focusHall ? focusHall.name : null;
  const summaries = hallsWithOrders
    .filter(({ hall }) => hall.name !== focusName)
    .map(({ hall, hallOrders }) => hallSummaryLine(hall, hallOrders));
  const focus = hallsWithOrders.find(({ hall }) => hall.name === focusName);

  const summaryText = summaries.join('\n');
  const fixed = header + summaryText + (focus ? '\n\n\n' : '');
  const focusText = focus
    ? detailedHallSection(focus.hall, focus.hallOrders, DELIVERY_MENU_MAX_LENGTH - fixed.length)
    : '';

  return `${header}${focusText}${focus && summaryText ? '\n\n\n' : ''}${summaryText}`
    .slice(0, DELIVERY_MENU_MAX_LENGTH);
}

/** Settings > Edit Dingo Post: what is currently set. */
function preorderPostText(custom) {
  const text = custom.text
    ? `"${custom.text}"`
    : 'Default - "🍱 Hall delivery orders are now open!"';

  return '📝 Dingo Post\n\n'
    + 'Your text replaces the first line of the stage-1 (orders open) post in the Dingo channel. '
    + 'The cutoff time, food list, contact line and ordering button are always added below it.\n\n'
    + `Text: ${text}\n`
    + `Photo: ${custom.photoFileId ? 'Attached - the post is sent as this photo, with the text as its caption' : 'None'}\n\n`
    + 'Changes apply to a live preorder post straight away.';
}

function preorderEditTextPromptText(maxLength) {
  return '✏️ Send the new first line for the preorder post.\n\n'
    + 'Write {hall} where the hall name should go, e.g.\n'
    + '"Supper is open! Preorders for {hall} onwards 🍜"\n\n'
    + `Up to ${maxLength} characters.`;
}

function preorderAttachPhotoPromptText() {
  return '🖼 Send the photo to show on the preorder post.\n\n'
    + 'Send it as a photo, not as a file.';
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
  spamOrdersText,
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
  editPriceListText,
  editPricePromptText,
  editStockPromptText,
  editAllStockStartText,
  updateCompleteText,
  manageHallsText,
  addHallPromptText,
  deleteHallSelectText,
  deliveryModeText,
  preorderPostText,
  preorderEditTextPromptText,
  preorderAttachPhotoPromptText,
};
