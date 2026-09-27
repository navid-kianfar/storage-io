import { useEffect } from 'react';
import { i18next } from '@/i18n';
import { directionOf, resolveTheme, usePreferences } from '@/stores/preferences';

/**
 * Pushes the preference store onto the document: `data-theme`, `data-density`,
 * `lang` and `dir`, plus i18next's active language.
 *
 * The same four attributes are written before first paint by the inline script in
 * index.html; this keeps them in step afterwards. Mounted once, at the top of the
 * tree, above both the shell and /login.
 */
export function useApplyPreferences(): void {
  const theme = usePreferences((state) => state.theme);
  const density = usePreferences((state) => state.density);
  const language = usePreferences((state) => state.language);
  const reduceMotion = usePreferences((state) => state.reduceMotion);

  useEffect(() => {
    const element = document.documentElement;
    element.dataset.theme = resolveTheme(theme);

    if (theme !== 'system') return;
    // Follow the OS while the choice is "system".
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      element.dataset.theme = query.matches ? 'dark' : 'light';
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotion ? 'true' : 'false';
  }, [reduceMotion]);

  useEffect(() => {
    const element = document.documentElement;
    element.lang = language;
    element.dir = directionOf(language);
    if (i18next.language !== language) void i18next.changeLanguage(language);
  }, [language]);
}
