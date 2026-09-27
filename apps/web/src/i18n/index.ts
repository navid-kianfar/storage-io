import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { LANGUAGES, type Language } from '@/stores/preferences';

import arAuth from './locales/ar/auth.json';
import arCommand from './locales/ar/command.json';
import arCommon from './locales/ar/common.json';
import arDomain from './locales/ar/domain.json';
import arNav from './locales/ar/nav.json';
import arPages from './locales/ar/pages.json';
import enAuth from './locales/en/auth.json';
import enCommand from './locales/en/command.json';
import enCommon from './locales/en/common.json';
import enDomain from './locales/en/domain.json';
import enNav from './locales/en/nav.json';
import enPages from './locales/en/pages.json';
import faAuth from './locales/fa/auth.json';
import faCommand from './locales/fa/command.json';
import faCommon from './locales/fa/common.json';
import faDomain from './locales/fa/domain.json';
import faNav from './locales/fa/nav.json';
import faPages from './locales/fa/pages.json';
import trAuth from './locales/tr/auth.json';
import trCommand from './locales/tr/command.json';
import trCommon from './locales/tr/common.json';
import trDomain from './locales/tr/domain.json';
import trNav from './locales/tr/nav.json';
import trPages from './locales/tr/pages.json';

/**
 * Namespaced, keyed messages. `en` is complete and is the fallback; `tr`, `fa`
 * and `ar` exist as empty objects on purpose — translation is a separate task,
 * and an empty namespace falls through to English key by key rather than
 * showing a raw key.
 *
 * Adding a namespace: create `locales/<lang>/<ns>.json` for all four languages
 * (the three non-English ones stay `{}`), import it here, and add it to NAMESPACES.
 */
export const NAMESPACES = ['common', 'nav', 'auth', 'command', 'domain', 'pages'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NAMESPACE: Namespace = 'common';

const resources = {
  en: {
    common: enCommon,
    nav: enNav,
    auth: enAuth,
    command: enCommand,
    domain: enDomain,
    pages: enPages,
  },
  tr: {
    common: trCommon,
    nav: trNav,
    auth: trAuth,
    command: trCommand,
    domain: trDomain,
    pages: trPages,
  },
  fa: {
    common: faCommon,
    nav: faNav,
    auth: faAuth,
    command: faCommand,
    domain: faDomain,
    pages: faPages,
  },
  ar: {
    common: arCommon,
    nav: arNav,
    auth: arAuth,
    command: arCommand,
    domain: arDomain,
    pages: arPages,
  },
} as const;

export function initI18n(language: Language): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources,
      lng: language,
      fallbackLng: 'en',
      supportedLngs: [...LANGUAGES],
      ns: [...NAMESPACES],
      defaultNS: DEFAULT_NAMESPACE,
      // Numbers, dates and sizes go through src/lib/format, never i18next.
      interpolation: { escapeValue: false },
      returnNull: false,
      // An empty string in a locale file means "not translated", not "blank".
      returnEmptyString: false,
      parseMissingKeyHandler: (key) => key,
    });
  }
  return i18next;
}

export { i18next };
