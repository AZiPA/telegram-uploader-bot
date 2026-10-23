import { t } from '../locales/index.js';
import { ACTIONS } from '../helpers.js';

export function buildFactoryResetKeyboard(lang) {
  return {
    inline_keyboard: [[
      {
        text: t(lang, 'btn_factory_reset_confirm'),
        callback_data: ACTIONS.FACTORY_RESET_CONFIRM || 'factory_reset:confirm',
        style: 'danger'
      },
      {
        text: t(lang, 'delete_confirm_no'),
        callback_data: 'factory_reset:cancel'
      }
    ]]
  };
}
