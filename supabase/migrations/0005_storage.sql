-- =============================================================================
-- 0005_storage.sql
-- Private bucket holding payment receipt images.
--
-- Objects are stored as {yyyy}/{mm}/{order_code}/{submission_id}.{ext}
--
-- The bucket MUST stay private. It contains bank screenshots with names,
-- account details and phone numbers. No storage policies are created, so the
-- anon and authenticated keys cannot read it at all; only the service role can.
-- Admins who need to view evidence get a short-lived signed URL generated
-- server-side by orderRepository.createReceiptSignedUrl().
--
-- If you change SUPABASE_RECEIPTS_BUCKET from the default, create that bucket
-- too: this migration only creates 'payment-receipts'.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-receipts',
  'payment-receipts',
  false,
  20971520, -- 20 MB, comfortably above Telegram's photo and image-document sizes
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
