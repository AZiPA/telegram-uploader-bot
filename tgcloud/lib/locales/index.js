import en from './en.js';
import fa from './fa.js';

export const LOCALES = { en, fa };
export const SUPPORTED_LANGUAGES = ['en', 'fa'];
export { en, fa };

export function resolveLanguage(from, defaultLang = 'en') {
  if (from?.language_code?.toLowerCase().startsWith('fa')) return 'fa';
  return defaultLang === 'fa' ? 'fa' : 'en';
}

function escapeHtmlParam(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function t(lang = 'en', key, params = {}) {
  const dict = (lang === 'fa' ? fa : en) || en;
  let str = dict[key] || (key === 'maintenance_active' ? dict['maintenance_alert'] : null) || en[key] || key;
  if (typeof str !== 'string') return str;
  for (const [k, v] of Object.entries(params)) {
    let val;
    if (v !== null && typeof v === 'object' && (v.isUserInput || v.escape || v.userInput)) {
      val = escapeHtmlParam(v.value ?? v.text ?? '');
    } else {
      val = String(v ?? '');
    }
    str = str.split('{' + k + '}').join(val);
  }
  return str;
}

export default { LOCALES, SUPPORTED_LANGUAGES, t, resolveLanguage, en, fa };
