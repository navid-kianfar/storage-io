import { CONFLICT_STRATEGIES, type ConflictStrategy } from '@storage-io/contracts';
import { ChevronRightIcon, FolderIcon, HouseIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import { Combobox, type ComboboxOption } from '@/components/app/Combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/app/Dialog';
import { Input } from '@/components/app/Input';
import { Label } from '@/components/app/Label';
import { ProviderMark } from '@/components/app/ProviderMark';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Spinner } from '@/components/app/Spinner';
import { useBuckets } from '@/features/buckets/api';
import { useServerList } from '@/features/shell/api';
import { toastProblem } from '@/lib/api/problems';
import { useCopyObjects, useObjectListing, type ObjectScope } from '../api';
import type { Entry } from '../entries';

/**
 * Copy to… / Move to…, which are the same request with one flag between them.
 *
 * The destination is picked rather than typed: a server, a bucket on it, and a
 * prefix browsed inside that bucket. Typing a prefix is still allowed — an operator
 * who knows where it goes should not have to click there — but the browser is what
 * makes "where does this go" answerable without leaving the dialog.
 *
 * One request for the whole selection: `POST …/objects/copy` takes `keys` and
 * `prefixes` together and answers with a job when the set is big enough to need
 * one.
 */

const BUCKET_PAGE_SIZE = 200;
const PREFIX_PAGE_LIMIT = 200;

export function CopyMoveDialog({
  open,
  onOpenChange,
  mode,
  scope,
  entries,
  sourcePrefix,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: 'copy' | 'move';
  readonly scope: ObjectScope;
  readonly entries: readonly Entry[];
  readonly sourcePrefix: string;
  readonly onDone?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <Body
          mode={mode}
          scope={scope}
          entries={entries}
          sourcePrefix={sourcePrefix}
          onCancel={() => onOpenChange(false)}
          onDone={() => {
            onOpenChange(false);
            onDone?.();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function Body({
  mode,
  scope,
  entries,
  sourcePrefix,
  onCancel,
  onDone,
}: {
  readonly mode: 'copy' | 'move';
  readonly scope: ObjectScope;
  readonly entries: readonly Entry[];
  readonly sourcePrefix: string;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const prefixId = useId();

  const servers = useServerList();
  /**
   * The route carries a server *name* while the picker's options are server ids,
   * so the source has to be resolved before it can be the selected option —
   * otherwise "copy into the folder next door" starts with an empty picker.
   */
  const sourceServerId =
    servers.data?.items.find(
      (server) => server.id === scope.serverId || server.name === scope.serverId,
    )?.id ?? null;

  const [destServerId, setDestServerId] = useState<string | null>(null);
  const chosenServerId = destServerId ?? sourceServerId;
  const [destBucket, setDestBucket] = useState<string | null>(scope.bucket);
  const [destPrefix, setDestPrefix] = useState(sourcePrefix);
  const [conflict, setConflict] = useState<ConflictStrategy>('skip');

  const copy = useCopyObjects(scope);

  const serverOptions = useMemo<readonly ComboboxOption[]>(
    () =>
      (servers.data?.items ?? []).map((server) => ({
        value: server.id,
        label: server.name,
        icon: <ProviderMark provider={server.provider} size="sm" />,
        disabled: server.status === 'offline',
      })),
    [servers.data],
  );

  const bucketList = useBuckets({
    serverId: chosenServerId ?? undefined,
    sort: 'name',
    page: 1,
    pageSize: BUCKET_PAGE_SIZE,
  });

  const bucketOptions = useMemo<readonly ComboboxOption[]>(
    () => (bucketList.data?.items ?? []).map((bucket) => ({ value: bucket.name, label: bucket.name })),
    [bucketList.data],
  );

  const normalizedPrefix = destPrefix === '' || destPrefix.endsWith('/') ? destPrefix : `${destPrefix}/`;
  const sameTarget =
    chosenServerId === sourceServerId &&
    destBucket === scope.bucket &&
    normalizedPrefix === sourcePrefix;

  const canSubmit =
    chosenServerId !== null &&
    destBucket !== null &&
    !sameTarget &&
    !copy.isPending &&
    entries.length > 0;

  function submit(): void {
    if (!canSubmit || chosenServerId === null || destBucket === null) return;
    copy.mutate(
      {
        keys: entries.filter((entry) => entry.kind === 'object').map((entry) => entry.kind === 'object' ? entry.object.key : ''),
        prefixes: entries.filter((entry) => entry.kind === 'prefix').map((entry) => entry.kind === 'prefix' ? entry.prefix : ''),
        destServerId: chosenServerId,
        destBucket,
        destPrefix: normalizedPrefix,
        move: mode === 'move',
        conflict,
      },
      {
        onSuccess: (response) => {
          if (response.job !== null) {
            toast.info(t('browse.copy.asJob'));
          } else {
            const key = mode === 'move' ? 'browse.copy.moved' : 'browse.copy.copied';
            toast.success(t(key, { count: response.copied }));
          }
          onDone();
        },
        onError: (error) => toastProblem(error, tCommon),
      },
    );
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          {mode === 'move' ? t('browse.copy.moveTitle') : t('browse.copy.copyTitle')}
        </DialogTitle>
        <DialogDescription>
          {t('browse.copy.description', { count: entries.length })}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('browse.copy.server')}</span>
          <Combobox
            options={serverOptions}
            value={chosenServerId}
            onValueChange={(next) => {
              setDestServerId(next);
              // A bucket and a prefix only mean something on the server they were
              // picked from, so choosing another server clears both.
              if (next === chosenServerId) return;
              setDestBucket(next === sourceServerId ? scope.bucket : null);
              setDestPrefix(next === sourceServerId ? sourcePrefix : '');
            }}
            placeholder={tCommon('form.comboboxPlaceholder')}
            aria-label={t('browse.copy.server')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">{t('browse.copy.bucket')}</span>
          <Combobox
            options={bucketOptions}
            value={destBucket}
            onValueChange={setDestBucket}
            placeholder={tCommon('form.comboboxPlaceholder')}
            disabled={chosenServerId === null || bucketList.isLoading}
            aria-label={t('browse.copy.bucket')}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={prefixId}>{t('browse.copy.prefix')}</Label>
        <Input
          id={prefixId}
          value={destPrefix}
          onChange={(event) => setDestPrefix(event.target.value)}
          placeholder="2026/09/"
          className="ltr-isolate font-mono"
        />
      </div>

      {chosenServerId === null || destBucket === null ? null : (
        <PrefixBrowser
          scope={{ serverId: chosenServerId, bucket: destBucket }}
          prefix={normalizedPrefix}
          onNavigate={setDestPrefix}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('browse.copy.conflict')}</span>
        <SegmentedControl
          options={CONFLICT_STRATEGIES.map((value) => ({
            value,
            label: t(`browse.copy.conflict${value.charAt(0).toUpperCase()}${value.slice(1)}`),
          }))}
          value={conflict}
          onValueChange={setConflict}
          className="w-full"
          aria-label={t('browse.copy.conflict')}
        />
      </div>

      {sameTarget ? (
        <Alert variant="warning">
          <AlertDescription>{t('browse.copy.sameTarget')}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={copy.isPending}>
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {copy.isPending ? <Spinner /> : null}
          {mode === 'move' ? t('browse.copy.moveSubmit') : t('browse.copy.copySubmit')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * The folders at the chosen destination, one level at a time. Only prefixes are
 * listed: the point is to pick where things go, and the objects already there are
 * noise for that decision.
 */
function PrefixBrowser({
  scope,
  prefix,
  onNavigate,
}: {
  readonly scope: ObjectScope;
  readonly prefix: string;
  readonly onNavigate: (prefix: string) => void;
}) {
  const { t } = useTranslation('pages');
  const listing = useObjectListing(
    scope,
    { prefix, showVersions: false, limit: PREFIX_PAGE_LIMIT },
    true,
  );

  const folders = listing.data?.pages.flatMap((page) => page.prefixes) ?? [];
  const parent = prefix === '' ? null : prefix.replace(/[^/]*\/$/, '');

  return (
    <div className="flex max-h-48 flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label={t('browse.path.root')} onClick={() => onNavigate('')}>
          <HouseIcon />
        </Button>
        <span className="ltr-isolate truncate font-mono text-xs text-muted-foreground">
          {scope.bucket}/{prefix}
        </span>
      </div>

      <div className="min-h-16 overflow-auto">
        {listing.isLoading ? (
          <div className="flex h-16 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <ul>
            {parent === null ? null : (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start font-mono"
                  onClick={() => onNavigate(parent)}
                >
                  <ChevronRightIcon className="flip-rtl rotate-180" />
                  ..
                </Button>
              </li>
            )}
            {folders.map((folder) => (
              <li key={folder.prefix}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start font-mono"
                  onClick={() => onNavigate(folder.prefix)}
                >
                  <FolderIcon />
                  <span className="ltr-isolate truncate">
                    {folder.prefix.slice(prefix.length).replace(/\/$/, '')}
                  </span>
                </Button>
              </li>
            ))}
            {folders.length === 0 && parent === null ? (
              <li className="px-3 py-3 text-[0.8125rem] text-muted-foreground">
                {t('browse.empty.title')}
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}
