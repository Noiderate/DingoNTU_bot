/**
 * Callback identifiers for button clicks
 */
const CALLBACKS = {
  // Main menu
  ADMIN_SETTINGS: 'admin_settings',
  ADMIN_SOLD_TODAY: 'admin_sold_today',
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
  FOOD_EDIT_PRICE: 'food_edit_price',
  FOOD_EDIT_PRICE_PREFIX: 'food_edit_price_',

  // Dingo channel preorder post: custom first line and optional photo
  SETTINGS_PREORDER_POST: 'settings_preorder_post',
  PREORDER_EDIT_TEXT: 'preorder_edit_text',
  PREORDER_RESET_TEXT: 'preorder_reset_text',
  PREORDER_ATTACH_PHOTO: 'preorder_attach_photo',
  PREORDER_REMOVE_PHOTO: 'preorder_remove_photo',
  PREORDER_PREVIEW: 'preorder_preview',

  // Spam orders (fake orders for testing)
  SETTINGS_SPAM_ORDERS: 'settings_spam_orders',
  SPAM_ORDERS_SMALL: 'spam_orders_small',
  SPAM_ORDERS_LARGE: 'spam_orders_large',
  SPAM_ORDERS_DELETE: 'spam_orders_delete',

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
  DELIVERY_MODE_SERVE_LIST_PREFIX: 'dmsl_',       // {hallName} -> (re)send that hall's serve list, no channel post
  // Legacy reset buttons: the reset is automatic now, these only answer taps on old messages.
  DELIVERY_MODE_RESET_FIRST: 'delivery_mode_reset_first',
  DELIVERY_MODE_REVERT_BLOCK: 'delivery_mode_revert_block',
  DELIVERY_MODE_FINISH: 'delivery_mode_finish',
  DELIVERY_MODE_RESET_HALLS: 'delivery_mode_reset_halls',
  DELIVERY_MODE_RESET_CONFIRM_PREFIX: 'dm_reset_yes:',
  DELIVERY_MODE_RESET_CANCEL_PREFIX: 'dm_reset_no:',
  // Stage 1 (orders open): posted from the reminder DM or the main admin menu.
  STAGE1_POST: 'stage1_post',
  STAGE1_POST_CONFIRM: 'stage1_post_yes',
  STAGE1_POST_CANCEL: 'stage1_post_no',
  // Stage 2 (spare stock): the confirm-stock screen opened by the Delivery Mode button.
  STAGE2_EDIT_PREFIX: 's2e_',           // {foodItemId} -> type a new total for that item
  STAGE2_BACK: 's2_back',
  STAGE2_CONFIRM: 's2_confirm',
  STAGE2_CANCEL: 's2_cancel',
  // Settings > Order Schedule.
  SETTINGS_ORDER_SCHEDULE: 'settings_order_schedule',
  ORDER_SCHEDULE_EDIT_POST: 'osch_post',
  ORDER_SCHEDULE_EDIT_CUTOFF: 'osch_cutoff',
};

/**
 * User state modes
 */
const STATES = {
  ADD_ADMIN: 'add_admin',
  EDIT_FOOD_STOCK_SPECIFIC: 'edit_food_stock_specific',
  EDIT_ALL_FOOD_STOCK_LOOP: 'edit_all_food_stock_loop',
  EDIT_FOOD_PRICE: 'edit_food_price',
  ADD_HALL: 'add_hall',
  EDIT_PREORDER_TEXT: 'edit_preorder_text',
  ATTACH_PREORDER_PHOTO: 'attach_preorder_photo',
  EDIT_POST_TIME: 'edit_post_time',
  EDIT_CUTOFF_TIME: 'edit_cutoff_time',
  EDIT_STAGE2_STOCK: 'edit_stage2_stock',
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
