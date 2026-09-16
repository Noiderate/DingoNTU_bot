function isMessageNotModifiedError(error) {
  const errorMessage = error && error.message ? error.message : '';
  return errorMessage.includes('message is not modified');
}

async function editMessageTextSafely(bot, text, options) {
  try {
    await bot.editMessageText(text, options);
    return { updated: true, skipped: false };
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return { updated: false, skipped: true };
    }

    throw error;
  }
}

async function editMessageCaptionSafely(bot, caption, options) {
  try {
    await bot.editMessageCaption(caption, options);
    return { updated: true, skipped: false };
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return { updated: false, skipped: true };
    }

    throw error;
  }
}

module.exports = {
  isMessageNotModifiedError,
  editMessageTextSafely,
  editMessageCaptionSafely,
};