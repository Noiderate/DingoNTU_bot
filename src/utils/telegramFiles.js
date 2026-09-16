/**
 * Image types accepted as a payment receipt.
 *
 * Customers are told they may send the screenshot "as a file" because Telegram
 * compresses photos, and that compression routinely renders a small reference
 * number unreadable - which would otherwise flag a perfectly valid payment.
 */
const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function isImageDocument(document) {
  return Boolean(document) && RECEIPT_MIME_TYPES.includes(document.mime_type);
}

module.exports = { RECEIPT_MIME_TYPES, isImageDocument };
