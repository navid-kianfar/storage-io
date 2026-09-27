import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { directionOf, resolveTheme, usePreferences } from '@/stores/preferences';

/**
 * The stock shadcn sonner wrapper reads the theme from `next-themes`, which this
 * app does not use — the theme lives in the preferences store and on
 * `<html data-theme>`. Everything else is the shadcn component.
 */
function Toaster({ ...props }: ToasterProps) {
  const theme = usePreferences((state) => state.theme);
  const language = usePreferences((state) => state.language);
  const resolved = theme === 'system' ? 'system' : resolveTheme(theme);
  const direction = directionOf(language);

  return (
    <Sonner
      theme={resolved}
      dir={direction}
      className="toaster group"
      // Sonner's positions are physical, so the inline-end corner is chosen here.
      position={direction === 'rtl' ? 'top-left' : 'top-right'}
      offset={{ top: 'calc(var(--topbar-h) + 0.75rem)', right: '1rem', left: '1rem' }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--success-bg': 'var(--popover)',
          '--success-text': 'var(--success-foreground)',
          '--error-bg': 'var(--popover)',
          '--error-text': 'var(--destructive-foreground)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
