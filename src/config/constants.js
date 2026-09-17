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
  DELIVERY_MODE_SERVE_ORDER_PREFIX: 'delivery_mode_serve_order_',
  DELIVERY_MODE_REVERT_BLOCK: 'delivery_mode_revert_block',
  DELIVERY_MODE_FINISH: 'delivery_mode_finish',
  DELIVERY_MODE_RESET_HALLS: 'delivery_mode_reset_halls',
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
