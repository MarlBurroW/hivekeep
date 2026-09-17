import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '@/shared/constants'
import en from '@/client/locales/en.json'

// English ships in the main bundle (it is the fallback). Every other locale is
// a lazy chunk, loaded on demand by changeAppLanguage so 10 languages don't
// add ~1.6MB to the initial bundle. Keep in sync with SUPPORTED_LANGUAGES
// (parity validated by scripts/check-locales.ts).
const LOCALE_LOADERS: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  fr: () => import('@/client/locales/fr.json'),
  es: () => import('@/client/locales/es.json'),
  de: () => import('@/client/locales/de.json'),
  'pt-BR': () => import('@/client/locales/pt-BR.json'),
  'zh-CN': () => import('@/client/locales/zh-CN.json'),
  ja: () => import('@/client/locales/ja.json'),
  ru: () => import('@/client/locales/ru.json'),
  it: () => import('@/client/locales/it.json'),
  pl: () => import('@/client/locales/pl.json'),
}

// Pre-login/onboarding language: best browser-language match against the
// shipped locales (exact tag first, then base language: pt → pt-BR). Once a
// profile exists, useAuth switches to user.language and this stops mattering.
function detectBrowserLanguage(): string {
  if (typeof navigator === 'undefined') return 'en'
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const pref of prefs) {
    if (!pref) continue
    const lower = pref.toLowerCase()
    const exact = SUPPORTED_LANGUAGES.find((l) => l.toLowerCase() === lower)
    if (exact) return exact
    const prefBase = lower.split('-')[0] ?? lower
    const baseMatch = SUPPORTED_LANGUAGES.find((l) => (l.split('-')[0] ?? l).toLowerCase() === prefBase)
    if (baseMatch) return baseMatch
  }
  return 'en'
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
})

/**
 * Switch the UI language, lazily loading its bundle first. Always use this
 * instead of `i18n.changeLanguage` — a raw changeLanguage to a not-yet-loaded
 * locale silently renders the English fallback.
 */
export async function changeAppLanguage(lng: string): Promise<void> {
  const target = (SUPPORTED_LANGUAGES as readonly string[]).includes(lng) ? lng : 'en'
  if (target !== 'en' && !i18n.hasResourceBundle(target, 'translation')) {
    try {
      const mod = await LOCALE_LOADERS[target]?.()
      if (mod) i18n.addResourceBundle(target, 'translation', mod.default)
    } catch {
      return // chunk failed to load (offline?): keep the current language
    }
  }
  await i18n.changeLanguage(target)
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.language
  i18n.on('languageChanged', language => { document.documentElement.lang = language })
}

// Kick off the pre-login best guess immediately (async: English renders for a
// frame at most while the locale chunk loads from the same origin).
void changeAppLanguage(detectBrowserLanguage())

export default i18n
