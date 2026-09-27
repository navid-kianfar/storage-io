import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-browser preferences. Anything that belongs to the *installation* lives in
 * `GET /settings` instead (density is in both: the server holds the default, this
 * store holds what this browser chose).
 *
 * The shape and the storage key are duplicated in the pre-paint script in
 * index.html — change them together, or the first paint disagrees with React.
 */
export const PREFERENCES_STORAGE_KEY = 'sio.prefs';

export const LANGUAGES = ['en', 'tr', 'fa', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

const RTL_LANGUAGES: readonly Language[] = ['fa', 'ar'];

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export type ResolvedTheme = 'light' | 'dark';
export type Direction = 'ltr' | 'rtl';

export interface PreferencesState {
  readonly theme: Theme;
  readonly density: Density;
  readonly language: Language;
  /** Honour the OS "reduce motion" setting even when the OS does not report it. */
  readonly reduceMotion: boolean;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setLanguage: (language: Language) => void;
  setReduceMotion: (reduceMotion: boolean) => void;
}

export function directionOf(language: Language): Direction {
  return RTL_LANGUAGES.includes(language) ? 'rtl' : 'ltr';
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      density: 'comfortable',
      language: 'en',
      reduceMotion: false,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setLanguage: (language) => set({ language }),
      setReduceMotion: (reduceMotion) => set({ reduceMotion }),
    }),
    {
      name: PREFERENCES_STORAGE_KEY,
      partialize: ({ theme, density, language, reduceMotion }) => ({
        theme,
        density,
        language,
        reduceMotion,
      }),
    },
  ),
);

/** `?theme=` / `?lang=` in the URL win once, so a screenshot or a bug report can pin them. */
export function applyUrlPreferenceOverrides(search: string): void {
  const query = new URLSearchParams(search);
  const theme = query.get('theme');
  const language = query.get('lang');
  if (theme && (THEMES as readonly string[]).includes(theme)) {
    usePreferences.getState().setTheme(theme as Theme);
  }
  if (language && (LANGUAGES as readonly string[]).includes(language)) {
    usePreferences.getState().setLanguage(language as Language);
  }
}
