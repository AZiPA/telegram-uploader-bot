export const OWNER_COMMANDS = {
  '/setbotowner': 4,
  '/transfer_ownership': 4,
  '/maintenance': 4,
  '/factoryreset': 4,
  '/restore': 4,
  '/setstoragechannel': 4,
  '/export_config': 4,
  '/import_config': 4,
};

export const OWNER_CALLBACK_PREFIXES = [
  'confirm_xfer:',
  'cancel_xfer:',
  'set:maint',
  'factory_reset:',
  'factory_reset:confirm',
];
