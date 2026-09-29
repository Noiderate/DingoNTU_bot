const { log } = require('./logger');

/**
 * Shrinks a receipt for long-term storage.
 *
 * Only the STORED copy is shrunk. Gemini still reads the original, and the
 * replay-guard hash is taken from the original bytes, so verification is
 * unaffected. The stored copy only has to stay legible for a dispute.
 *
 * A phone screenshot is ~1290x2796, so the cap is on the LONGEST side and set
 * high enough (2000px) that the small print on a bank screen stays readable.
 */

const MAX_SIDE_PX = 2000;
const JPEG_QUALITY = 72;
// Refuse to decode absurdly large images (decompression bombs).
const MAX_INPUT_PIXELS = 60 * 1000 * 1000;

/**
 * @returns {Promise<{ buffer: Buffer, mimeType: string, extension: string, shrunk: boolean }|null>}
 *   null means "keep the original": the resize failed, or it did not make the
 *   file any smaller (an already-small JPEG).
 */
async function shrinkForStorage(buffer) {
  try {
    // Required lazily so a missing native binary can never stop the bot from
    // starting - it just stores originals, as it did before.
    const sharp = require('sharp');

    const output = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // honour EXIF orientation before the metadata is dropped
      .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    if (output.length >= buffer.length) {
      return null;
    }

    return { buffer: output, mimeType: 'image/jpeg', extension: 'jpg', shrunk: true };
  } catch (error) {
    log('warn', 'receipt_shrink_failed', { error: error.message });
    return null;
  }
}

module.exports = { shrinkForStorage, MAX_SIDE_PX, JPEG_QUALITY };
