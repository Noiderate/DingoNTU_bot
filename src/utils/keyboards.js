const { CALLBACKS } = require('../config/constants');

function createCallbackItemToken(value) {
  const text = String(value || '');
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

/**
 * Main admin menu keyboard
 */
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '⚙️ Settings', callback_data: CALLBACKS.ADMIN_SETTINGS }],
      [{ text: '🚚 Enter Delivery Mode', callback_data: CALLBACKS.SETTINGS_DELIVERY_MODE }],
      [{ text: '📊 Stats', callback_data: CALLBACKS.ADMIN_STATS }],
      [{ text: '🔄 Reload Settings', callback_data: CALLBACKS.ADMIN_RELOAD }],
    ],
  };
}

/**
 * Settings menu keyboard
 */
function settingsMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '👥 Manage Admins', callback_data: CALLBACKS.SETTINGS_MANAGE_ADMINS }],
      [{ text: '🍔 Manage Food Items', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }],
      [{ text: '🏢 Manage Halls', callback_data: CALLBACKS.SETTINGS_MANAGE_HALLS }],
      [{ text: '📝 Edit Dingo Post', callback_data: CALLBACKS.SETTINGS_PREORDER_POST }],
      [{ text: '← Back', callback_data: CALLBACKS.ADMIN_MENU_BACK }],
    ],
  };
}

/**
 * Manage admins keyboard
 */
function manageAdminsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Add Admin', callback_data: CALLBACKS.MANAGE_ADD_ADMIN }],
      [{ text: '➖ Delete Admin', callback_data: CALLBACKS.MANAGE_DELETE_ADMIN }],
      [{ text: '🏷️ Set Admin to Tag', callback_data: CALLBACKS.SETTINGS_SET_ADMIN_TAG }],
      [{ text: '← Back', callback_data: CALLBACKS.ADMIN_SETTINGS }],
    ],
  };
}

/**
 * Admin list keyboard with delete buttons
 */
function adminListKeyboard(adminIds) {
  const buttons = adminIds.map(adminId => [
    { text: `${adminId}`, callback_data: `${CALLBACKS.DELETE_ADMIN_PREFIX}${adminId}` }
  ]);
  buttons.push([{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_ADMINS }]);
  return { inline_keyboard: buttons };
}

/**
 * Admin selection keyboard for tagging (with usernames)
 */
function selectAdminToTagKeyboard(adminList, currentTagAdminId) {
  const buttons = adminList.map(admin => {
    const username = admin.username ? `@${admin.username}` : 'no handle';
    const isCurrent = admin.id === currentTagAdminId ? ' ✓' : '';
    return [{ text: `${admin.id} (${username})${isCurrent}`, callback_data: `${CALLBACKS.SET_ADMIN_TAG_PREFIX}${admin.id}` }];
  });
  buttons.push([{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_ADMINS }]);
  return { inline_keyboard: buttons };
}

/**
 * Add admin prompt keyboard
 */
function addAdminKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_ADMINS }]],
  };
}

/**
 * Back to main menu keyboard
 */
function backToMainMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.ADMIN_MENU_BACK }]],
  };
}

/**
 * Back to food management keyboard
 */
function backToFoodMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }]],
  };
}

/**
 * Manage food items keyboard
 */
function manageFoodItemsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Add Food Item', callback_data: CALLBACKS.FOOD_ADD }],
      [{ text: '➖ Delete Food Item', callback_data: CALLBACKS.FOOD_DELETE }],
      [{ text: '📊 Edit Specific Stock', callback_data: CALLBACKS.FOOD_EDIT_STOCK }],
      [{ text: '📊 Edit All Stock', callback_data: CALLBACKS.FOOD_EDIT_ALL_STOCK }],
      [{ text: '💲 Edit Price', callback_data: CALLBACKS.FOOD_EDIT_PRICE }],
      [{ text: '← Back', callback_data: CALLBACKS.ADMIN_SETTINGS }],
    ],
  };
}

/**
 * Food items with delete buttons
 */
function foodItemsDeleteKeyboard(foodItems) {
  const buttons = foodItems.map(item => [
    {
      text: `${item.name} ($${item.price})`,
      callback_data: `${CALLBACKS.FOOD_DELETE_PREFIX}${item.id}:${createCallbackItemToken(item.name)}`,
    }
  ]);
  buttons.push([{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }]);
  return { inline_keyboard: buttons };
}

/**
 * Food items with stock edit buttons
 */
function foodItemsEditStockKeyboard(foodItems) {
  const buttons = foodItems.map(item => [
    { text: `${item.name} (Stock: ${item.stock || 0})`, callback_data: `${CALLBACKS.FOOD_EDIT_STOCK_PREFIX}${item.id}` }
  ]);
  buttons.push([{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }]);
  return { inline_keyboard: buttons };
}

/**
 * Food items with price edit buttons
 */
function foodItemsEditPriceKeyboard(foodItems) {
  const buttons = foodItems.map(item => [
    {
      text: `${item.name} ($${Number(item.price).toFixed(2)})`,
      callback_data: `${CALLBACKS.FOOD_EDIT_PRICE_PREFIX}${item.id}`,
    },
  ]);
  buttons.push([{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }]);
  return { inline_keyboard: buttons };
}

/**
 * Add food item prompt keyboard
 */
function addFoodItemKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }]],
  };
}

/**
 * Cancel stock editing keyboard
 */
function cancelStockEditKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Cancel', callback_data: CALLBACKS.SETTINGS_MANAGE_FOODS }]],
  };
}

/**
 * Manage halls keyboard
 */
function manageHallsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Add Hall', callback_data: CALLBACKS.HALL_ADD }],
      [{ text: '➖ Delete Hall', callback_data: CALLBACKS.HALL_DELETE }],
      [{ text: '← Back', callback_data: CALLBACKS.ADMIN_SETTINGS }],
    ],
  };
}

/**
 * Halls with delete buttons
 */
function hallsDeleteKeyboard(halls) {
  const buttons = halls.map(hall => [
    {
      text: `${hall.name}`,
      callback_data: `${CALLBACKS.HALL_DELETE_PREFIX}${hall.id}:${createCallbackItemToken(hall.name)}`,
    }
  ]);
  buttons.push([{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_HALLS }]);
  return { inline_keyboard: buttons };
}

/**
 * Add hall prompt keyboard
 */
function addHallKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_HALLS }]],
  };
}

/**
 * Back to halls keyboard
 */
function backToHallsKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_MANAGE_HALLS }]],
  };
}

/**
 * Settings > Edit Dingo Post. The clear/remove buttons only appear when
 * there is something custom to clear.
 */
function preorderPostKeyboard(custom) {
  const textRow = [{ text: '✏️ Edit Text', callback_data: CALLBACKS.PREORDER_EDIT_TEXT }];
  if (custom.text) {
    textRow.push({ text: '↩️ Use Default Text', callback_data: CALLBACKS.PREORDER_RESET_TEXT });
  }

  const photoRow = [{
    text: custom.photoFileId ? '🖼 Replace Photo' : '🖼 Attach Photo',
    callback_data: CALLBACKS.PREORDER_ATTACH_PHOTO,
  }];
  if (custom.photoFileId) {
    photoRow.push({ text: '🗑 Remove Photo', callback_data: CALLBACKS.PREORDER_REMOVE_PHOTO });
  }

  return {
    inline_keyboard: [
      textRow,
      photoRow,
      [{ text: '👁 Preview', callback_data: CALLBACKS.PREORDER_PREVIEW }],
      [{ text: '← Back', callback_data: CALLBACKS.ADMIN_SETTINGS }],
    ],
  };
}

/** Back out of an Edit Dingo Post prompt without changing anything. */
function backToPreorderPostKeyboard() {
  return {
    inline_keyboard: [[{ text: '← Back', callback_data: CALLBACKS.SETTINGS_PREORDER_POST }]],
  };
}

// get-ready and coming now post automatically off hall serve progress; only
// these two stages still need an admin tap.
const MANUALLY_POSTED_MODES = ['preorder', 'here'];

/**
 * Delivery mode menu keyboard
 *
 * comingNeedsManualPost: true for the very first hall's 'coming' post, which
 * has no previous hall to auto-trigger off of (see getGatingHall in
 * deliveryMode.js) and so needs a manual button same as 'here' does.
 *
 * resetRequired: last round was never reset, so the preorder button is
 * swapped for one that starts the reset (see deliveryMode.isResetRequired).
 * serveListHalls: [{ hall, count }] for halls already visited this round that
 * still have unserved orders - one button each to bring back their serve list.
 */
function deliveryModeKeyboard(
  nextHallToPost, nextHallToPostMode, lastBlockedHall, showFinish, hallHasNoOrders, comingNeedsManualPost = false,
  { resetRequired = false, serveListHalls = [] } = {}
) {
  const buttons = [];
  const canManuallyPost = nextHallToPost && (
    MANUALLY_POSTED_MODES.includes(nextHallToPostMode)
    || (nextHallToPostMode === 'coming' && comingNeedsManualPost)
  );

  if (canManuallyPost && nextHallToPostMode === 'preorder' && resetRequired) {
    buttons.push([{ text: '🔄 Reset Halls and Orders first', callback_data: CALLBACKS.DELIVERY_MODE_RESET_FIRST }]);
  } else if (canManuallyPost) {
    const postText = nextHallToPostMode === 'preorder'
      ? `Post preorder available message   `
      : nextHallToPostMode === 'coming'
        ? `${nextHallToPost.shortName || nextHallToPost.name}, we are coming   `
        : `${nextHallToPost.shortName || nextHallToPost.name}, we are here   `;

    const callbackData = `${CALLBACKS.DELIVERY_MODE_POST_CHANNEL_PREFIX}${nextHallToPostMode}:${nextHallToPost.id}`;

    buttons.push([{ text: postText, callback_data: callbackData }]);

    // Same action as the button above (and as /skip) - posting never checks
    // order count. This just makes it visible up front that there is
    // nobody to serve, so skipping past this hall needs no second-guessing.
    if ((nextHallToPostMode === 'here' || (nextHallToPostMode === 'coming' && comingNeedsManualPost)) && hallHasNoOrders) {
      buttons.push([{
        text: `⏭️ Skip ${nextHallToPost.shortName || nextHallToPost.name} - no orders`,
        callback_data: callbackData,
      }]);
    }
  }

  if (showFinish) {
    buttons.push([{
      text: '✅ Finish Delivery',
      callback_data: CALLBACKS.DELIVERY_MODE_FINISH,
    }]);
  }

  if (lastBlockedHall) {
    buttons.push([{
      text: `↩️ Revert ${lastBlockedHall}`,
      callback_data: CALLBACKS.DELIVERY_MODE_REVERT_BLOCK,
    }]);
  }

  for (const { hall, count } of serveListHalls) {
    buttons.push([{
      text: `📋 Serve list: ${hall.shortName || hall.name} (${count})`,
      callback_data: `${CALLBACKS.DELIVERY_MODE_SERVE_LIST_PREFIX}${hall.name}`,
    }]);
  }

  buttons.push([{ text: '← Back to Admin Menu', callback_data: CALLBACKS.DELIVERY_MODE_BACK }]);

  return {
    inline_keyboard: buttons,
  };
}

module.exports = {
  createCallbackItemToken,
  mainMenuKeyboard,
  settingsMenuKeyboard,
  manageAdminsKeyboard,
  adminListKeyboard,
  selectAdminToTagKeyboard,
  addAdminKeyboard,
  backToMainMenuKeyboard,
  backToFoodMenuKeyboard,
  manageFoodItemsKeyboard,
  foodItemsDeleteKeyboard,
  foodItemsEditStockKeyboard,
  foodItemsEditPriceKeyboard,
  addFoodItemKeyboard,
  cancelStockEditKeyboard,
  manageHallsKeyboard,
  hallsDeleteKeyboard,
  addHallKeyboard,
  backToHallsKeyboard,
  deliveryModeKeyboard,
  preorderPostKeyboard,
  backToPreorderPostKeyboard,
};
