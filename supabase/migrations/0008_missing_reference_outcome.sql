-- =============================================================================
-- 0008_missing_reference_outcome.sql
-- A receipt where everything checked out except that no reference number was
-- visible is now handed back to the customer to resend (like a repeat
-- screenshot) instead of going straight to an admin. It needs its own outcome
-- so the verifier can count how many times an order has been asked, and send
-- the next one to an admin (some banks never print a reference).
--
-- Not a "live" outcome: like incomplete_transfer it is left out of the
-- reference/image claim indexes, so the customer may resend the same image.
--
-- Apply BEFORE deploying the code that writes it. Until then, such a receipt
-- fails to save and is escalated to an admin as a verification failure.
-- =============================================================================

alter type payment_outcome add value if not exists 'missing_reference';
