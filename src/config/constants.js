/**
 * Callback identifiers for button clicks
 */
const CALLBACKS = {
  // Main menu
  ADMIN_SETTINGS: 'admin_settings',
  ADMIN_STATS: 'admin_stats',
  ADMIN_RELOAD: 'admin_reload',
  ADMIN_MENU_BACK: 'admin_menu_back',

  // Admins
  SETTINGS_MANAGE_ADMINS: 'settings_manage_admins',
  MANAGE_ADD_ADMIN: 'manage_add_admin',
  MANAGE_DELETE_ADMIN: 'manage_delete_admin',
  DELETE_ADMIN_PREFIX: 'delete_admin_',
  SETTINGS_SET_ADMIN_TAG: 'settings_set_admin_tag',
  SET_ADMIN_TAG_PREFIX: 'set_admin_tag_',

  // Food Items
  SETTINGS_MANAGE_FOODS: 'settings_manage_foods',
  FOOD_ADD: 'food_add',
  FOOD_DELETE: 'food_delete',
  FOOD_DELETE_PREFIX: 'delete_food_',
  FOOD_EDIT_STOCK: 'food_edit_stock',
  FOOD_EDIT_STOCK_PREFIX: 'food_edit_stock_',
  FOOD_EDIT_ALL_STOCK: 'food_edit_all_stock',

  // Halls
  SETTINGS_MANAGE_HALLS: 'settings_manage_halls',
  HALL_ADD: 'hall_add',
  HALL_DELETE: 'hall_delete',
  HALL_DELETE_PREFIX: 'delete_hall_',

  // Orders
  ORDER_CONFIRM_PREFIX: 'order_confirm_',
  ORDER_REJECT_PREFIX: 'order_reject_',

  // Payment screenshot review
  PAYMENT_ACCEPT_PREFIX: 'payment_accept_',
  PAYMENT_REJECT_PREFIX: 'payment_reject_',

  // Delivery mode
  SETTINGS_DELIVERY_MODE: 'settings_delivery_mode',
  DELIVERY_MODE_BACK: 'delivery_mode_back',
  DELIVERY_MODE_POST_CHANNEL_PREFIX: 'delivery_mode_post_channel_',
  // Hall serve list: kept short, since a 64-byte callback_data budget has to
  // fit an order's UUID too (see admin.js's serve-list functions).
  DELIVERY_MODE_SERVE_CUSTOMER_PREFIX: 'dmsc_',   // {hallName}|{telegramUserId} -> open their submenu
  DELIVERY_MODE_SERVE_MARK_SERVED_PREFIX: 'dmss_', // {orderId} -> mark served
  DELIVERY_MODE_SERVE_MARK_DROPPED_PREFIX: 'dmsd_', // {orderId} -> mark dropped off
  DELIVERY_MODE_SERVE_BACK_PREFIX: 'dmsb_',       // {hallName} -> back to the phone-number list
  DELIVERY_MODE_SERVE_REMAINING_PREFIX: 'dmsr_',  // {hallName} -> collated remaining items + customer list
  DELIVERY_MODE_SERVE_DROPOFF_PREFIX: 'dmsp_',    // {hallName}|{telegramUserId} -> start the drop-off photo relay
  DELIVERY_MODE_REVERT_BLOCK: 'delivery_mode_revert_block',
  DELIVERY_MODE_FINISH: 'delivery_mode_finish',
  // Reset flow, each carrying Finish Delivery's one-time token after a colon:
  // the first tap asks "are you sure", the second actually resets.
  DELIVERY_MODE_RESET_HALLS: 'delivery_mode_reset_halls',
  DELIVERY_MODE_RESET_CONFIRM_PREFIX: 'dm_reset_yes:',
  DELIVERY_MODE_RESET_CANCEL_PREFIX: 'dm_reset_no:',
};

/**
 * User state modes
 */
const STATES = {
  ADD_ADMIN: 'add_admin',
  EDIT_FOOD_STOCK_SPECIFIC: 'edit_food_stock_specific',
  EDIT_ALL_FOOD_STOCK_LOOP: 'edit_all_food_stock_loop',
  ADD_HALL: 'add_hall',
};

/**
 * Check if callback is of a certain prefix type
 */
function isCallbackType(data, prefix) {
  return data.startsWith(prefix);
}

/**
 * Extract value from prefixed callback
 */
function extractCallbackValue(data, prefix) {
  return data.substring(prefix.length);
}

module.exports = {
  CALLBACKS,
  STATES,
  isCallbackType,
  extractCallbackValue,
};
