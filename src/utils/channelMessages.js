const COMING_MESSAGE_VARIANTS = [
  'we are coming',
  'we r cmgggg',
];

function getRandomComingMessageVariant() {
  if (!COMING_MESSAGE_VARIANTS.length) {
    return 'we are coming';
  }

  const randomIndex = Math.floor(Math.random() * COMING_MESSAGE_VARIANTS.length);
  return COMING_MESSAGE_VARIANTS[randomIndex];
}

function buildComingChannelMessage(hallLabel) {
  const variant = getRandomComingMessageVariant();
  return `${hallLabel}, ${variant}`;
}

module.exports = {
  COMING_MESSAGE_VARIANTS,
  buildComingChannelMessage,
};