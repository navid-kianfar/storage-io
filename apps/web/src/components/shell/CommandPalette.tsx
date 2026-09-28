import {
  SEARCH_RESULT_TYPES,
  type SearchResult,
  type SearchResultType,
} from '@storage-io/contracts';
import { useNavigate, type NavigateOptions } from '@tanstack/react-router';
import {
  DatabaseIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  LayersIcon,
  MonitorIcon,
  MoonIcon,
  ServerCogIcon,
  ServerIcon,
  ShieldCheckIcon,
  SunIcon,
  UploadIcon,
  UserPlusIcon,
  UsersIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NAV_ITEMS } from '@/components/shell/navigation';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { useGlobalSearch } from '@/features/shell/api';
import { LANGUAGES, THEMES, usePreferences, type Theme } from '@/stores/preferences';

/**
 * ⌘K / Ctrl-K, and "/" from anywhere that is not a text field.
 *
 * Four groups, in the order the concept drew them:
 *   Navigation  — every sidebar destination, with its G-sequence hint.
 *   Actions     — every create action, each navigating to that dialog's own
 *                 route. None of them is a placeholder.
 *   Results     — live `GET /search` across servers, buckets, users, keys,
 *                 policies and jobs, from two characters up.
 *   Preferences — theme and language.
 */

interface PaletteAction {
  /** A route from docs/ROUTES.md; typed against the real route tree. */
  readonly to: NavigateOptions['to'];
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  readonly shortcut?: string;
}

/**
 * Every "New…" action is a route now (docs/ROUTES.md), so the palette navigates
 * rather than asking a registry to open a dialog. `/browse` is the entry point for
 * uploading: it is where a bucket is chosen, and an upload route needs one.
 */
const ACTIONS: readonly PaletteAction[] = [
  {
    to: '/browse',
    labelKey: 'action.uploadFiles',
    icon: UploadIcon,
    keywords: ['put', 'send', 'objects'],
    shortcut: 'U',
  },
  {
    to: '/buckets/new',
    labelKey: 'action.createBucket',
    icon: FolderPlusIcon,
    keywords: ['new', 'make', 'bucket'],
    shortcut: 'C B',
  },
  {
    to: '/servers/new',
    labelKey: 'action.addServer',
    icon: ServerCogIcon,
    keywords: ['connect', 'endpoint', 'minio', 'seaweedfs', 'aws', 'ceph', 'garage'],
  },
  {
    to: '/keys/new',
    labelKey: 'action.createAccessKey',
    icon: KeyRoundIcon,
    keywords: ['token', 'secret', 'credential'],
  },
  {
    to: '/users/new',
    labelKey: 'action.createS3User',
    icon: UserPlusIcon,
    keywords: ['iam', 'account'],
  },
  {
    to: '/policies/new',
    labelKey: 'action.createPolicy',
    icon: ShieldCheckIcon,
    keywords: ['iam', 'permission', 'grant'],
  },
  {
    to: '/jobs/new',
    labelKey: 'action.startBulkJob',
    icon: LayersIcon,
    keywords: ['copy', 'move', 'delete', 'batch', 'tag'],
  },
];

const RESULT_ICONS: Readonly<Record<SearchResultType, LucideIcon>> = {
  server: ServerIcon,
  bucket: DatabaseIcon,
  user: UsersIcon,
  group: UsersRoundIcon,
  key: KeyRoundIcon,
  policy: ShieldCheckIcon,
  job: LayersIcon,
};

const THEME_ICONS: Readonly<Record<Theme, LucideIcon>> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

const RESULT_TYPE_ORDER = new Map(SEARCH_RESULT_TYPES.map((type, index) => [type, index]));

function byTypeThenLabel(left: SearchResult, right: SearchResult): number {
  const byType = (RESULT_TYPE_ORDER.get(left.type) ?? 0) - (RESULT_TYPE_ORDER.get(right.type) ?? 0);
  return byType !== 0 ? byType : left.label.localeCompare(right.label);
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  // Mounted only while open, so the query resets by remounting rather than in an
  // effect: an old search must never greet the next ⌘K, and no search request is
  // in flight while the palette is closed.
  return open ? <CommandPaletteBody onOpenChange={onOpenChange} /> : null;
}

function CommandPaletteBody({ onOpenChange }: { readonly onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation('command');
  const { t: tNav } = useTranslation('nav');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const setTheme = usePreferences((state) => state.setTheme);
  const setLanguage = usePreferences((state) => state.setLanguage);
  const [term, setTerm] = useState('');

  const search = useGlobalSearch(term);
  const results = [...(search.data?.items ?? [])].sort(byTypeThenLabel);

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  /**
   * Where a result goes. `SearchResult.href` is the API's own answer and it now
   * follows docs/ROUTES.md — an id route, never a name and never a query string —
   * so it is followed directly rather than rebuilt here from `type` + `id`. The
   * switch that used to do that is gone: two route tables that have to agree is
   * one too many, and this one was already wrong for four of the six types.
   *
   * The href is data from the API, so it is navigated to as a plain string; a
   * value that is not a route the app has lands on the 404 page, which is the
   * honest outcome.
   */
  const openResult = (result: SearchResult): void => {
    void navigate({ href: result.href });
  };

  return (
    <CommandDialog
      open
      onOpenChange={onOpenChange}
      title={t('title')}
      description={t('searchHint')}
      className="top-[12vh] translate-y-0 sm:max-w-160"
    >
      <CommandInput placeholder={t('placeholder')} value={term} onValueChange={setTerm} />
      <CommandList className="max-h-[min(26rem,55vh)]">
        <CommandEmpty>{search.isFetching ? t('searching') : t('empty')}</CommandEmpty>

        <CommandGroup heading={t('group.navigation')}>
          {NAV_ITEMS.map((item) => (
            <CommandItem
              key={item.to}
              value={`nav-${item.to}`}
              keywords={[tNav(`item.${item.labelKey}`)]}
              onSelect={() => run(() => void navigate({ to: item.to }))}
            >
              <item.icon />
              <span>{tNav(`item.${item.labelKey}`)}</span>
              {item.shortcut === undefined ? null : (
                <CommandShortcut>{item.shortcut}</CommandShortcut>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('group.actions')}>
          {ACTIONS.map((action) => (
            <CommandItem
              key={action.to}
              value={`action-${action.to}`}
              keywords={[t(action.labelKey), ...action.keywords]}
              onSelect={() => run(() => void navigate({ to: action.to }))}
            >
              <action.icon />
              <span>{t(action.labelKey)}</span>
              {action.shortcut === undefined ? null : (
                <CommandShortcut>{action.shortcut}</CommandShortcut>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        {results.length > 0 || search.isFetching ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('group.results')}>
              {search.isFetching && results.length === 0 ? (
                <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                  <Spinner />
                  {t('searching')}
                </div>
              ) : null}
              {results.map((result) => {
                const Icon = RESULT_ICONS[result.type];
                return (
                  <CommandItem
                    key={`${result.type}-${result.id}`}
                    value={`result-${result.type}-${result.id}`}
                    // The live term is a keyword on every result, so cmdk's filter
                    // keeps what the API already matched — including a fuzzy match
                    // whose label does not literally contain what was typed — while
                    // still narrowing Navigation and Actions locally.
                    keywords={[result.label, result.sublabel, term]}
                    onSelect={() => run(() => openResult(result))}
                  >
                    <Icon />
                    <span className="ltr-isolate truncate font-mono">{result.label}</span>
                    <span className="ms-auto truncate text-xs text-muted-foreground">
                      {result.sublabel}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />

        <CommandGroup heading={t('group.preferences')}>
          {THEMES.map((option) => {
            const Icon = THEME_ICONS[option];
            return (
              <CommandItem
                key={`theme-${option}`}
                value={`theme-${option}`}
                keywords={['theme', 'dark', 'light', 'mode', tCommon(`theme.${option}`)]}
                onSelect={() => run(() => setTheme(option))}
              >
                <Icon />
                <span>{t('preference.theme', { value: tCommon(`theme.${option}`) })}</span>
              </CommandItem>
            );
          })}
          {LANGUAGES.map((option) => (
            <CommandItem
              key={`lang-${option}`}
              value={`lang-${option}`}
              keywords={['language', 'locale', option]}
              onSelect={() => run(() => setLanguage(option))}
            >
              <span className="w-4 font-mono text-xs text-muted-foreground">
                {option.toUpperCase()}
              </span>
              <span>
                {t('preference.language', { value: tCommon(`language.${option}`, { lng: 'en' }) })}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>

      <div className="flex items-center gap-4 border-t bg-muted px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {t('footer.navigate')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          {t('footer.select')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>esc</Kbd>
          {t('footer.close')}
        </span>
      </div>
    </CommandDialog>
  );
}
