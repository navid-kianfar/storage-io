import {
  SEARCH_RESULT_TYPES,
  type SearchResult,
  type SearchResultType,
} from '@storage-io/contracts';
import { useNavigate } from '@tanstack/react-router';
import {
  DatabaseIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  LayersIcon,
  LinkIcon,
  MonitorIcon,
  MoonIcon,
  ServerCogIcon,
  ServerIcon,
  ShieldCheckIcon,
  SunIcon,
  UploadIcon,
  UserPlusIcon,
  UsersIcon,
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
import type { DialogKey } from '@/lib/dialogs/registry';
import { useDialogs } from '@/lib/dialogs/useDialogs';
import { LANGUAGES, THEMES, usePreferences, type Theme } from '@/stores/preferences';

/**
 * ⌘K / Ctrl-K, and "/" from anywhere that is not a text field.
 *
 * Four groups, in the order the concept drew them:
 *   Navigation  — every sidebar destination, with its G-sequence hint.
 *   Actions     — every create action, each opening a real dialog by URL
 *                 (`?dialog=…`). None of them is a placeholder.
 *   Results     — live `GET /search` across servers, buckets, users, keys,
 *                 policies and jobs, from two characters up.
 *   Preferences — theme and language.
 */

interface PaletteAction {
  readonly dialog: DialogKey;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly keywords: readonly string[];
  readonly shortcut?: string;
}

const ACTIONS: readonly PaletteAction[] = [
  {
    dialog: 'upload',
    labelKey: 'action.uploadFiles',
    icon: UploadIcon,
    keywords: ['put', 'send', 'objects'],
    shortcut: 'U',
  },
  {
    dialog: 'create-bucket',
    labelKey: 'action.createBucket',
    icon: FolderPlusIcon,
    keywords: ['new', 'make', 'bucket'],
    shortcut: 'C B',
  },
  {
    dialog: 'add-server',
    labelKey: 'action.addServer',
    icon: ServerCogIcon,
    keywords: ['connect', 'endpoint', 'minio', 'seaweedfs', 'aws', 'ceph', 'garage'],
  },
  {
    dialog: 'create-access-key',
    labelKey: 'action.createAccessKey',
    icon: KeyRoundIcon,
    keywords: ['token', 'secret', 'credential'],
  },
  {
    dialog: 'create-s3-user',
    labelKey: 'action.createS3User',
    icon: UserPlusIcon,
    keywords: ['iam', 'account'],
  },
  {
    dialog: 'new-job',
    labelKey: 'action.startBulkJob',
    icon: LayersIcon,
    keywords: ['copy', 'move', 'delete', 'batch', 'tag'],
  },
  {
    dialog: 'share-link',
    labelKey: 'action.shareLink',
    icon: LinkIcon,
    keywords: ['presign', 'url', 'share'],
  },
];

const RESULT_ICONS: Readonly<Record<SearchResultType, LucideIcon>> = {
  server: ServerIcon,
  bucket: DatabaseIcon,
  user: UsersIcon,
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

/**
 * A bucket, user, key or policy result is identified by `"<serverId>/<name>"`.
 * The name can itself contain a slash for a bucket path, so only the first
 * separator is a separator.
 */
function splitScopedId(id: string): { readonly serverId: string; readonly name: string } {
  const separator = id.indexOf('/');
  if (separator < 0) return { serverId: '', name: id };
  return { serverId: id.slice(0, separator), name: id.slice(separator + 1) };
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
  const dialogs = useDialogs();
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
   * Where a result goes. `SearchResult.href` is not used: the API builds it from
   * a route plan this app does not have (`/access/users?…`, `/access/keys?…`,
   * `/access/policies/:server/:name`, `/jobs/:id`, and `/browse/:server/:bucket`
   * without the prefix splat), so following it 404s for four of the six types.
   * Reported to the lead. Every target below is derived from `type` and `id`,
   * which are stable, and typed against the real route tree.
   *
   * Route params carry ids, never names (docs/ROUTES.md rule 1). The bucket
   * segment is still a name because `/browse/$server/$bucket/$` has no bucket id
   * in it yet; the routing refactor replaces that route with
   * `/buckets/$bucketId/browse/$` and this switch with it.
   */
  const openResult = (result: SearchResult): void => {
    const { serverId, name } = splitScopedId(result.id);

    switch (result.type) {
      case 'server':
        void navigate({ to: '/servers/$server', params: { server: result.id } });
        return;
      case 'bucket':
        void navigate({
          to: '/browse/$server/$bucket/$',
          params: { server: serverId, bucket: name, _splat: '' },
        });
        return;
      case 'user':
        void navigate({ to: '/users', search: { serverId, q: name } });
        return;
      case 'key':
        void navigate({ to: '/keys', search: { serverId, q: name } });
        return;
      case 'policy':
        void navigate({ to: '/policies', search: { policyServer: serverId, policy: name } });
        return;
      case 'job':
        // There is no per-job route or URL-addressable job sheet yet, so this is
        // as precise as the palette can be. Reported to the lead.
        void navigate({ to: '/jobs' });
        return;
    }
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
              key={action.dialog}
              value={`action-${action.dialog}`}
              keywords={[t(action.labelKey), ...action.keywords]}
              onSelect={() => run(() => dialogs.open(action.dialog))}
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
