export default {
  locales: {
    supported: ['en', 'fa'],
    default: 'en',
  },
  limits: {
    rateLimitMessagesPerMin: 20,
    maxUploadSizeMb: 50,
    sqlConsoleMaxRows: 40,
    transferTokenTtlSec: 60,
  },
  features: {
    sqlConsole: true,
    fileHub: true,
    autoPurgeTempFiles: true,
  },
};
