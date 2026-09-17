const QRCode = require('qrcode');

/**
 * Builds a per-order PayNow QR code.
 *
 * The payload is the EMV "Merchant Presented QR" format that Singapore banks
 * scan for SGQR/PayNow, with the amount and order code baked in (point of
 * initiation "12" = dynamic) so the payer's banking app pre-fills the amount
 * and locks it from editing, and shows the order code as the reference.
 */

/**
 * CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. This
 * is the exact variant the EMV QR spec requires for the trailing checksum
 * field (tag 63) - a different CRC variant produces a code real banking apps
 * reject as corrupt.
 */
function crc16(payload) {
  let crc = 0xffff;

  for (let i = 0; i < payload.length; i += 1) {
    crc ^= payload.charCodeAt(i) << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  const length = String(Buffer.byteLength(value, 'utf8')).padStart(2, '0');
  return `${id}${length}${value}`;
}

/**
 * Build the PayNow merchant-account-info template (EMV tag 26).
 *
 * A UEN is preferred over a mobile proxy because it is a fixed identifier
 * that cannot expire or be reassigned - the same preference matchRecipient()
 * in paymentRules.js uses when checking a receipt against these same values.
 *
 * Returns null when neither is configured: there is no PayNow identity to
 * encode a QR for.
 */
function buildMerchantAccountInfo({ uen, mobile }) {
  let proxyType;
  let proxyValue;

  if (uen) {
    proxyType = '2';
    proxyValue = uen;
  } else if (mobile) {
    proxyType = '0';
    proxyValue = mobile;
  } else {
    return null;
  }

  return tlv('26', [
    tlv('00', 'SG.PAYNOW'),
    tlv('01', proxyType),
    tlv('02', proxyValue),
    tlv('03', '0'), // amount is fixed - the payer cannot edit it
  ].join(''));
}

/**
 * Build the full EMV QR payload string for one order.
 *
 * Returns null when neither a UEN nor a mobile proxy is configured, so the
 * caller can fall back to a static instruction image instead.
 */
function buildPayNowPayload({ uen, mobile, amountCents, merchantName, reference }) {
  const merchantAccountInfo = buildMerchantAccountInfo({ uen, mobile });

  if (!merchantAccountInfo) {
    return null;
  }

  const fields = [
    tlv('00', '01'), // payload format indicator
    tlv('01', '12'), // dynamic: this QR is generated per-order
    merchantAccountInfo,
    tlv('52', '0000'), // merchant category code (unclassified)
    tlv('53', '702'), // ISO 4217 numeric currency code for SGD
    tlv('54', (amountCents / 100).toFixed(2)),
    tlv('58', 'SG'),
    tlv('59', (merchantName || 'NA').slice(0, 25)),
    tlv('60', 'Singapore'),
  ];

  if (reference) {
    fields.push(tlv('62', tlv('01', String(reference).slice(0, 25))));
  }

  const withoutCrc = `${fields.join('')}6304`;
  return withoutCrc + crc16(withoutCrc);
}

/**
 * Render a PayNow QR for one order as a PNG buffer.
 *
 * Never throws for a missing identity - returns null so the caller can fall
 * back to the static instruction image.
 */
async function generatePayNowQrPng({ uen, mobile, amountCents, merchantName, reference }) {
  const payload = buildPayNowPayload({ uen, mobile, amountCents, merchantName, reference });

  if (!payload) {
    return null;
  }

  return QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
}

module.exports = {
  buildPayNowPayload,
  generatePayNowQrPng,
  crc16,
};
