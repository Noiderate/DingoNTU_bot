-- =============================================================================
-- 0006_customer_phone_number.sql
-- Adds a contact phone number to customers, collected the first time someone
-- confirms an order (see src/handlers/user.js). Used so staff at a hall can
-- identify and reach a customer, since a Telegram handle is not always a real
-- name and is useless once the app is closed.
--
-- Nullable: existing customers from before this migration have none yet, and
-- are asked for one the next time they confirm an order.
-- =============================================================================

alter table customers add column if not exists phone_number text;
