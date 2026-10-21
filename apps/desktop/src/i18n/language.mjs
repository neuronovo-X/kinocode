/** Studio's languages: the app's own words (the menu bar, its dialogs, the install window) come in each of them. */
export const LANGUAGES = ['en', 'ru', 'zh-CN', 'ja', 'ko', 'es'];

/**
 * The language the app speaks: the one Studio's page is in (or was last shown in), else Russian (КиноКод: Studio's
 * own default until the person chooses). `system` is how Studio picks the system's (its i18n `languageFor`).
 * @param {string | null | undefined} saved
 * @param {readonly string[]} [system] the system's preferred languages, most preferred first
 */
export function appLanguage(saved, system = []) {
  if (saved && LANGUAGES.includes(saved)) return saved;
  if (!saved) return 'ru';
  for (const tag of system) {
    const lower = String(tag).toLowerCase();
    if (lower.startsWith('zh')) {
      if (/^zh-(hant|tw|hk|mo)\b/.test(lower)) continue;
      return 'zh-CN';
    }
    const base = lower.split('-')[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return 'en';
}
