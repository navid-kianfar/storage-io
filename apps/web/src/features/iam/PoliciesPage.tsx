import {
  type PolicyDecision,
  type PolicyStatement,
  type PolicySummary,
} from '@storage-io/contracts';
import { Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BracesIcon,
  CircleCheckIcon,
  CircleXIcon,
  CopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  EllipsisIcon,
  FileJsonIcon,
  HistoryIcon,
  InfoIcon,
  LayersIcon,
  LockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ButtonGroup,
  CodeEditor,
  Combobox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FileDropzone,
  FormField,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ListRow,
  Num,
  PageHeader,
  RelativeTime,
  SectionCard,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ComboboxOption,
  type DroppedFile,
} from '@/components/app';
import { useBuckets } from '@/features/buckets/api';
import {
  useDeleteIamPolicy,
  useIamPolicies,
  useIamPolicy,
  useIamPolicyById,
  usePutIamPolicy,
  useSimulatePolicy,
  useValidatePolicy,
  type PolicyRef,
} from '@/features/iam/api';
import { PolicyVersionsSheet } from '@/features/iam/components/PolicyVersionsSheet';
import { StatementEditorDialog } from '@/features/iam/components/StatementEditorDialog';
import { UnavailableServersAlert } from '@/features/iam/components/UnavailableServersAlert';
import {
  COMMON_S3_ACTIONS,
  POLICY_TEMPLATES,
  asList,
  resourceSuggestions,
  statementsOf,
  withStatements,
  type PolicyTemplate,
} from '@/features/iam/policyTemplates';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { routeState, useRouteOverlay } from '@/lib/dialogs/route';
import { downloadText } from '@/lib/csv/csv';

/**
 * Policies: the list on the left, one document on the right.
 *
 * The editor's two tabs are two views of **one** document, and that is the whole
 * design problem this page has to get right. The source of truth while editing is
 * the JSON text; the visual editor parses it, changes one statement and writes the
 * text back. That direction is deliberate — the opposite (an object model that
 * serialises to text) silently drops anything the visual editor does not model,
 * such as a condition operator this app cannot evaluate, and an operator would
 * discover it only after saving.
 *
 * When the JSON does not parse, the visual tab says so instead of showing an empty
 * statement list, because an empty list reads as "this policy grants nothing".
 *
 * A built-in policy is read-only everywhere: the fields, both editors, Save and
 * Delete. The concept's "duplicate it to make a version you own" is the way out,
 * and it is a real action here.
 */

const BUCKET_PICKER_PAGE_SIZE = 500;
const DECISION_BADGES: Readonly<Record<PolicyDecision, 'success' | 'danger' | 'secondary'>> = {
  allow: 'success',
  deny: 'danger',
  'implicit-deny': 'secondary',
};

interface EditorState {
  readonly text: string;
  readonly description: string;
  readonly dirty: boolean;
}

export function PoliciesPage() {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();

  const search = useSearch({ strict: false });
  const query = typeof search.q === 'string' ? search.q : '';
  const serverId = typeof search.serverId === 'string' ? search.serverId : null;
  /**
   * Which policy the editor shows is identity, not view state, so it is the route
   * `/policies/$policyId` — never `?policy=…&policyServer=…`, which put a name
   * and a server id in the query string and was two ways to say one thing.
   */
  const overlay = useRouteOverlay();
  const selected = useIamPolicyById(overlay.params.policyId);

  /** A document imported from a file, waiting to be reviewed and saved. */
  const [imported, setImported] = useState<string | null>(null);

  const servers = useServers();
  const policies = useIamPolicies({
    ...(query.length > 0 ? { q: query } : {}),
    ...(serverId === null ? {} : { serverId }),
  });
  const buckets = useBuckets({ sort: 'name', page: 1, pageSize: BUCKET_PICKER_PAGE_SIZE });

  const items = useMemo(() => policies.data?.items ?? [], [policies.data]);
  const builtIn = useMemo(() => items.filter((entry) => entry.builtIn), [items]);
  const custom = useMemo(() => items.filter((entry) => !entry.builtIn), [items]);

  /**
   * What the editor edits, addressed by server + name. It comes from the resolved
   * route id; with no id in the URL the editor is the page's documented empty
   * state rather than a policy nobody asked for.
   */
  const ref = useMemo<PolicyRef | null>(() => {
    const entity = selected.data;
    return entity === undefined ? null : { serverId: entity.serverId, name: entity.name };
  }, [selected.data]);

  const select = useCallback(
    (entry: PolicySummary) => {
      void navigate({
        to: '/policies/$policyId',
        params: { policyId: entry.id },
        search: true,
      });
    },
    [navigate],
  );

  const setSearch = useCallback(
    (next: Record<string, string | undefined>) => {
      void navigate({
        to: '/policies',
        search: (current: Record<string, unknown>) => ({ ...current, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? [])
        .filter((server) => server.capabilities.iamPolicies === 'supported')
        .map((server) => ({ value: server.id, label: server.name })),
    [servers.data],
  );

  const bucketNames = useMemo(
    () =>
      (buckets.data?.items ?? [])
        .filter((bucket) => ref === null || bucket.serverId === ref.serverId)
        .map((bucket) => bucket.name),
    [buckets.data, ref],
  );

  return (
    <>
      <PageHeader
        title={t('policies.title')}
        description={t('policies.description')}
        actions={
          <>
            <ImportJsonButton
              onImport={(text) => {
                setImported(text);
                toast.success(t('policies.import.loaded'));
              }}
            />
            <ButtonGroup>
              <Button onClick={() => void navigate({ to: '/policies/new', search: true })}>
                <PlusIcon />
                {t('policies.newPolicy')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" aria-label={t('policies.startFromTemplate')}>
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuLabel>{t('policies.startFromTemplate')}</DropdownMenuLabel>
                  {POLICY_TEMPLATES.map((template) => (
                    <DropdownMenuItem
                      key={template}
                      onSelect={() =>
                        void navigate({
                          to: '/policies/new',
                          search: true,
                          state: routeState({
                            template,
                            ...(ref === null ? {} : { serverId: ref.serverId }),
                          }),
                        })
                      }
                    >
                      <FileJsonIcon />
                      {t(`policies.template.${template satisfies PolicyTemplate}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          </>
        }
      />

      <UnavailableServersAlert unavailable={policies.data?.unavailable ?? []} />

      <div className="grid gap-(--gap) lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <SectionCard flush className="h-fit">
          <div className="flex items-center gap-2 border-b p-3">
            <InputGroup className="min-w-0 flex-1">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(event) => setSearch({ q: event.target.value })}
                placeholder={t('policies.filterPlaceholder')}
                aria-label={t('policies.filterPlaceholder')}
              />
            </InputGroup>
            <Combobox
              options={serverOptions}
              value={serverId}
              onValueChange={(next) => setSearch({ serverId: next ?? undefined })}
              placeholder={t('users.allServers')}
              clearable
              className="w-32"
              aria-label={t('users.serverFilter')}
            />
          </div>

          <div className="max-h-[32rem] overflow-y-auto">
            {policies.isLoading ? (
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={ShieldAlertIcon}
                title={
                  query.length > 0 || serverId !== null
                    ? tCommon('state.noResults')
                    : t('policies.empty.title')
                }
                description={t('policies.empty.description')}
              />
            ) : (
              <>
                <PolicyGroup
                  label={t('policies.group.builtIn')}
                  entries={builtIn}
                  selected={ref}
                  onSelect={select}
                />
                <PolicyGroup
                  label={t('policies.group.custom')}
                  entries={custom}
                  selected={ref}
                  onSelect={select}
                />
              </>
            )}
          </div>

          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              <Num value={items.length} /> {t('policies.countSuffix')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigate({ to: '/policies/new', search: true })}
            >
              <PlusIcon />
              {tCommon('action.create')}
            </Button>
          </div>
        </SectionCard>

        {ref === null ? (
          <SectionCard>
            <EmptyState
              icon={ShieldCheckIcon}
              title={t('policies.noSelection.title')}
              description={t('policies.noSelection.description')}
            />
          </SectionCard>
        ) : (
          <PolicyEditor
            key={`${ref.serverId}/${ref.name}`}
            policyRef={ref}
            bucketNames={bucketNames}
            imported={imported}
            onImportConsumed={() => setImported(null)}
            onSelect={select}
          />
        )}
      </div>

      {/* `/policies/new` renders here. */}
      <Outlet />
    </>
  );
}

function PolicyGroup({
  label,
  entries,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly entries: readonly PolicySummary[];
  readonly selected: PolicyRef | null;
  readonly onSelect: (entry: PolicySummary) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <>
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-1.5">
        <span className="text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <span className="num text-xs text-muted-foreground">
          <Num value={entries.length} />
        </span>
      </div>
      {entries.map((entry) => {
        const active = selected?.name === entry.name && selected.serverId === entry.serverId;
        return (
          <button
            key={`${entry.serverId}/${entry.name}`}
            type="button"
            onClick={() => onSelect(entry)}
            aria-current={active}
            className="flex w-full items-center gap-2 border-b px-3 py-2 text-start last:border-b-0 hover:bg-accent aria-[current=true]:bg-primary/8 aria-[current=true]:shadow-[inset_2px_0_0_var(--primary)]"
          >
            {entry.builtIn ? (
              <LockIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ShieldCheckIcon
                className={active ? 'size-3.5 shrink-0 text-primary' : 'size-3.5 shrink-0 text-muted-foreground'}
                aria-hidden="true"
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-[0.8125rem] font-medium">{entry.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {entry.serverName}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <UsersIcon className="size-3.5" aria-hidden="true" />
              <Num value={entry.attachedCount} />
            </span>
          </button>
        );
      })}
    </>
  );
}

/* ------------------------------- the editor ------------------------------ */

function PolicyEditor({
  policyRef,
  bucketNames,
  imported,
  onImportConsumed,
  onSelect,
}: {
  readonly policyRef: PolicyRef;
  readonly bucketNames: readonly string[];
  /** A document imported from a file at page level; unsaved until the operator saves. */
  readonly imported: string | null;
  readonly onImportConsumed: () => void;
  readonly onSelect: (entry: PolicySummary) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const detail = useIamPolicy(policyRef);
  const putPolicy = usePutIamPolicy();
  const deletePolicy = useDeleteIamPolicy();
  const validate = useValidatePolicy();
  const simulate = useSimulatePolicy();

  const loaded = detail.data;

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [view, setView] = useState('visual');
  const [statementIndex, setStatementIndex] = useState<number | null>(null);
  const [addingStatement, setAddingStatement] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [duplicateName, setDuplicateName] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // The server's document is the baseline; `editor` holds the operator's unsaved
  // text. Deriving the displayed text rather than copying the response into state
  // in an effect is what keeps a refetch from clobbering an edit in progress.
  const serverText = useMemo(
    () => (loaded === undefined ? '' : JSON.stringify(loaded.document, null, 2)),
    [loaded],
  );
  const text = editor?.text ?? imported ?? serverText;
  const description = editor?.description ?? loaded?.description ?? '';
  const dirty = editor?.dirty ?? imported !== null;

  const parsed = useMemo(() => {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false as const };
      }
      return { ok: true as const, document: value as Record<string, unknown> };
    } catch {
      return { ok: false as const };
    }
  }, [text]);

  const statements = useMemo(
    () => (parsed.ok ? statementsOf(parsed.document) : []),
    [parsed],
  );

  const readOnly = loaded?.builtIn ?? false;

  const writeStatements = useCallback(
    (next: readonly PolicyStatement[]) => {
      if (!parsed.ok) return;
      const document = withStatements(parsed.document, next);
      setEditor({
        text: JSON.stringify(document, null, 2),
        description,
        dirty: true,
      });
    },
    [description, parsed],
  );

  const save = useCallback(() => {
    if (!parsed.ok || loaded === undefined) return;
    putPolicy.mutate(
      {
        serverId: policyRef.serverId,
        name: policyRef.name,
        document: parsed.document,
        description,
      },
      {
        onSuccess: () => {
          toast.success(t('policies.toast.saved'), { description: policyRef.name });
          setEditor(null);
          onImportConsumed();
        },
        onError: (error) => apiError.toastError(error, t('policies.toast.saveFailed')),
      },
    );
  }, [apiError, description, loaded, onImportConsumed, parsed, policyRef, putPolicy, t]);

  const runValidate = useCallback(() => {
    if (!parsed.ok) {
      toast.error(t('policies.toast.invalidJson'));
      return;
    }
    validate.mutate(
      { document: parsed.document },
      {
        onSuccess: (result) => {
          if (result.valid && result.warnings.length === 0) {
            toast.success(t('policies.toast.valid'), {
              description: t('policies.statementCount', { count: statements.length }),
            });
            return;
          }
          if (result.valid) {
            toast.warning(t('policies.toast.validWithWarnings'), {
              description: result.warnings.join(' · '),
            });
            return;
          }
          toast.error(t('policies.toast.invalid'), {
            description: result.errors.map((error) => `${error.path}: ${error.message}`).join(' · '),
          });
        },
        onError: (error) => apiError.toastError(error, t('policies.toast.validateFailed')),
      },
    );
  }, [apiError, parsed, statements.length, t, validate]);

  const duplicate = useCallback(
    (newName: string) => {
      if (!parsed.ok) return;
      putPolicy.mutate(
        {
          serverId: policyRef.serverId,
          name: newName,
          document: parsed.document,
          description: description.length > 0 ? description : '',
        },
        {
          onSuccess: (created) => {
            toast.success(t('policies.toast.duplicated'), { description: newName });
            setDuplicateName(null);
            onSelect(created);
          },
          onError: (error) => apiError.toastError(error, t('policies.toast.duplicateFailed')),
        },
      );
    },
    [apiError, description, onSelect, parsed, policyRef.serverId, putPolicy, t],
  );

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => toast.success(tCommon('action.copied')),
      () => toast.error(t('keys.copyFailed')),
    );
  };

  if (detail.isLoading) {
    return (
      <div className="flex flex-col gap-(--gap)">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  if (detail.isError || loaded === undefined) {
    return (
      <SectionCard>
        <EmptyState
          icon={ShieldAlertIcon}
          title={tCommon('state.error')}
          description={apiError.message(detail.error)}
        />
      </SectionCard>
    );
  }

  const arn = `arn:aws:iam:::policy/${loaded.name}`;

  return (
    <div className="flex min-w-0 flex-col gap-(--gap)">
      <SectionCard
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{loaded.name}</span>
            {loaded.builtIn ? (
              <>
                <Badge variant="secondary">{t('users.sheet.builtIn')}</Badge>
                <Badge variant="secondary">
                  <LockIcon />
                  {t('policies.readOnly')}
                </Badge>
              </>
            ) : (
              <Badge variant="outline">{t('users.sheet.custom')}</Badge>
            )}
          </span>
        }
        description={loaded.description ?? t('policies.noDescription')}
        action={
          <>
            <Button variant="outline" size="sm" onClick={() => copy(arn)}>
              <CopyIcon />
              {t('policies.copyArn')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label={t('jobs.moreActions')}>
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => copy(arn)}>
                  <CopyIcon />
                  {t('policies.copyArn')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => downloadText(text, `${loaded.name}.json`, 'application/json')}
                >
                  <DownloadIcon />
                  {t('policies.downloadJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setImportOpen(true)} disabled={readOnly}>
                  <FileJsonIcon />
                  {t('policies.importJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setShowVersions(true)}>
                  <HistoryIcon />
                  {t('policies.versionHistory')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDuplicateName(`${loaded.name}-copy`)}>
                  <CopyPlusIcon />
                  {t('policies.duplicate')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={readOnly}
                  onSelect={() => setConfirmDelete(true)}
                >
                  <Trash2Icon />
                  {t('policies.deletePolicy')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
        footer={
          <>
            <Button variant="outline" onClick={runValidate} disabled={validate.isPending}>
              {validate.isPending ? <Spinner /> : <CircleCheckIcon />}
              {t('policies.validate')}
            </Button>
            <Button variant="outline" onClick={() => setDuplicateName(`${loaded.name}-copy`)}>
              <CopyPlusIcon />
              {t('policies.duplicate')}
            </Button>
            <Button variant="outline" disabled={readOnly} onClick={() => setConfirmDelete(true)}>
              <Trash2Icon />
              {tCommon('action.delete')}
            </Button>
            <span className="ms-auto text-xs text-muted-foreground">
              {loaded.updatedAt === null ? null : (
                <>
                  {t('policies.lastSaved')} <RelativeTime value={loaded.updatedAt} />
                </>
              )}
            </span>
            <Button onClick={save} disabled={readOnly || !dirty || !parsed.ok || putPolicy.isPending}>
              {putPolicy.isPending ? <Spinner /> : null}
              {t('policies.saveChanges')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={t('policies.create.name')} className="sm:col-span-2">
            {({ id }) => (
              <Input id={id} value={loaded.name} disabled className="font-mono" dir="ltr" />
            )}
          </FormField>
          <FormField label={t('users.create.server')}>
            {({ id }) => (
              <Input id={id} value={loaded.serverName} disabled className="font-mono" dir="ltr" />
            )}
          </FormField>
          <FormField
            label={t('policies.create.descriptionLabel')}
            className="sm:col-span-2"
          >
            {({ id }) => (
              <Input
                id={id}
                value={description}
                disabled={readOnly}
                onChange={(event) =>
                  setEditor({ text, description: event.target.value, dirty: true })
                }
              />
            )}
          </FormField>
          <FormField label={t('policies.version')} hint={t('policies.versionHint')}>
            {({ id }) => <Input id={id} value="2012-10-17" disabled className="font-mono" dir="ltr" />}
          </FormField>
        </div>

        {readOnly ? (
          <Alert variant="warning" className="mt-4">
            <LockIcon />
            <AlertTitle>{t('policies.builtInTitle')}</AlertTitle>
            <AlertDescription>{t('policies.builtInBody')}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-6">
          <Tabs value={view} onValueChange={setView}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList aria-label={t('policies.editorLabel')}>
                <TabsTrigger value="visual">
                  <LayersIcon />
                  {t('policies.visual')}
                </TabsTrigger>
                <TabsTrigger value="json">
                  <BracesIcon />
                  {t('policies.json')}
                </TabsTrigger>
              </TabsList>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <InfoIcon className="size-3.5" aria-hidden="true" />
                {t('policies.sameDocument')}
              </span>
            </div>

            <TabsContent value="visual" className="mt-4 flex flex-col gap-3">
              {!parsed.ok ? (
                <Alert variant="danger">
                  <CircleXIcon />
                  <AlertTitle>{t('policies.invalidJsonTitle')}</AlertTitle>
                  <AlertDescription>{t('policies.invalidJsonBody')}</AlertDescription>
                </Alert>
              ) : statements.length === 0 ? (
                <EmptyState
                  icon={LayersIcon}
                  title={t('policies.noStatements')}
                  description={t('policies.noStatementsHint')}
                />
              ) : (
                statements.map((statement, index) => (
                  <StatementCard
                    key={`${statement.Sid ?? 'statement'}-${String(index)}`}
                    statement={statement}
                    index={index}
                    total={statements.length}
                    readOnly={readOnly}
                    onEdit={() => setStatementIndex(index)}
                    onDuplicate={() =>
                      writeStatements([
                        ...statements.slice(0, index + 1),
                        {
                          ...statement,
                          Sid: `${statement.Sid ?? 'Statement'}Copy`,
                        },
                        ...statements.slice(index + 1),
                      ])
                    }
                    onRemove={() =>
                      writeStatements(statements.filter((_entry, i) => i !== index))
                    }
                    onMove={(direction) => {
                      const target = index + direction;
                      if (target < 0 || target >= statements.length) return;
                      const next = [...statements];
                      const moved = next[index];
                      const other = next[target];
                      if (moved === undefined || other === undefined) return;
                      next[index] = other;
                      next[target] = moved;
                      writeStatements(next);
                    }}
                  />
                ))
              )}

              <Button
                variant="outline"
                className="w-full"
                disabled={readOnly || !parsed.ok}
                onClick={() => setAddingStatement(true)}
              >
                <PlusIcon />
                {t('policies.addStatement')}
              </Button>
            </TabsContent>

            <TabsContent value="json" className="mt-4 flex flex-col gap-2">
              <CodeEditor
                value={text}
                onValueChange={(next) => setEditor({ text: next, description, dirty: true })}
                language="json"
                readOnly={readOnly}
                height="22rem"
                ariaLabel={t('policies.documentLabel')}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5">
                  {parsed.ok ? (
                    <>
                      <CircleCheckIcon className="size-3.5 text-success" aria-hidden="true" />
                      <span className="text-muted-foreground">
                        {t('policies.validJson')} ·{' '}
                        {t('policies.statementCount', { count: statements.length })}
                      </span>
                    </>
                  ) : (
                    <>
                      <CircleXIcon className="size-3.5 text-destructive" aria-hidden="true" />
                      <span className="text-destructive">{t('policies.invalidJsonTitle')}</span>
                    </>
                  )}
                </span>
                <Button variant="ghost" size="sm" onClick={() => copy(text)}>
                  <CopyIcon />
                  {t('policies.copyJson')}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </SectionCard>

      <div className="grid gap-(--gap) xl:grid-cols-2">
        <SectionCard
          title={t('policies.attached.title')}
          description={t('policies.attached.description')}
          action={<Badge variant="secondary">{loaded.attachedTo.users.length + loaded.attachedTo.groups.length}</Badge>}
          flush
        >
          {loaded.attachedTo.users.length === 0 && loaded.attachedTo.groups.length === 0 ? (
            <EmptyState
              icon={ShieldAlertIcon}
              title={t('policies.attached.emptyTitle')}
              description={t('policies.attached.emptyDescription')}
            />
          ) : (
            <>
              {loaded.attachedTo.users.map((name) => (
                <ListRow
                  key={`user-${name}`}
                  media={<UserRoundIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
                  title={<span className="font-mono">{name}</span>}
                  subtitle={loaded.serverName}
                  trailing={<Badge variant="outline">{t('policies.attached.user')}</Badge>}
                />
              ))}
              {loaded.attachedTo.groups.map((name) => (
                <ListRow
                  key={`group-${name}`}
                  media={<UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />}
                  title={<span className="font-mono">{name}</span>}
                  subtitle={loaded.serverName}
                  trailing={<Badge variant="outline">{t('policies.attached.group')}</Badge>}
                />
              ))}
            </>
          )}
        </SectionCard>

        <SimulateCard
          document={parsed.ok ? parsed.document : null}
          bucketNames={bucketNames}
          onSimulate={(request, onDone) =>
            simulate.mutate(request, {
              onSuccess: onDone,
              onError: (error) => apiError.toastError(error, t('policies.toast.simulateFailed')),
            })
          }
          busy={simulate.isPending}
        />
      </div>

      {statementIndex === null ? null : (
        <StatementEditorDialog
          statement={statements[statementIndex] ?? null}
          index={statementIndex}
          bucketSuggestions={resourceSuggestions(bucketNames)}
          onSave={(next) => {
            writeStatements(
              statements.map((entry, i) => (i === statementIndex ? next : entry)),
            );
            setStatementIndex(null);
          }}
          onClose={() => setStatementIndex(null)}
        />
      )}

      {addingStatement ? (
        <StatementEditorDialog
          statement={null}
          index={statements.length}
          bucketSuggestions={resourceSuggestions(bucketNames)}
          onSave={(next) => {
            writeStatements([...statements, next]);
            setAddingStatement(false);
          }}
          onClose={() => setAddingStatement(false)}
        />
      ) : null}

      {showVersions ? (
        <PolicyVersionsSheet
          policy={policyRef}
          onClose={() => setShowVersions(false)}
          onRestored={() => {
            setEditor(null);
            setShowVersions(false);
          }}
        />
      ) : null}

      <ImportPolicyDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(imported) => {
          setEditor({ text: imported, description, dirty: true });
          setView('json');
          setImportOpen(false);
          toast.success(t('policies.import.loaded'));
        }}
      />

      <DuplicateDialog
        key={duplicateName ?? 'none'}
        name={duplicateName}
        onClose={() => setDuplicateName(null)}
        onConfirm={duplicate}
        busy={putPolicy.isPending}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('policies.delete.title')}
        description={t('policies.delete.description')}
        confirmValue={loaded.name}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={deletePolicy.isPending}
        onConfirm={() =>
          deletePolicy.mutate(policyRef, {
            onSuccess: () => {
              toast.success(t('policies.toast.deleted'), { description: loaded.name });
              setConfirmDelete(false);
            },
            onError: (error) => apiError.toastError(error, t('policies.toast.deleteFailed')),
          })
        }
      >
        {loaded.attachedTo.users.length + loaded.attachedTo.groups.length === 0 ? null : (
          <Alert variant="danger">
            <AlertDescription>
              {t('policies.delete.attachedWarning', {
                count: loaded.attachedTo.users.length + loaded.attachedTo.groups.length,
              })}
            </AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------ statements ------------------------------- */

function StatementCard({
  statement,
  index,
  total,
  readOnly,
  onEdit,
  onDuplicate,
  onRemove,
  onMove,
}: {
  readonly statement: PolicyStatement;
  readonly index: number;
  readonly total: number;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
  readonly onMove: (direction: 1 | -1) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const allow = statement.Effect === 'Allow';
  const actions = asList(statement.Action);
  const notActions = asList(statement.NotAction);
  const resources = asList(statement.Resource);
  const notResources = asList(statement.NotResource);
  const conditions = Object.entries(statement.Condition ?? {}).flatMap(([operator, pairs]) =>
    Object.entries(pairs).map(([key, value]) => ({
      operator,
      key,
      value: Array.isArray(value) ? value.map(String).join(', ') : String(value),
    })),
  );

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Badge variant={allow ? 'success' : 'danger'}>
          {allow ? <CircleCheckIcon /> : <CircleXIcon />}
          {t(`policies.effect.${allow ? 'Allow' : 'Deny'}`)}
        </Badge>
        <span className="truncate font-mono text-[0.8125rem] font-medium">
          {statement.Sid ?? t('policies.unnamedStatement')}
        </span>
        <span className="ms-auto text-xs text-muted-foreground">
          {t('policies.statementNumber', { index: index + 1 })}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('policies.statementActions', { index: index + 1 })}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit} disabled={readOnly}>
              <PencilIcon />
              {t('policies.statement.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate} disabled={readOnly}>
              <CopyPlusIcon />
              {t('policies.statement.duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onMove(-1)} disabled={readOnly || index === 0}>
              <ArrowUpIcon />
              {t('policies.statement.moveUp')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onMove(1)}
              disabled={readOnly || index === total - 1}
            >
              <ArrowDownIcon />
              {t('policies.statement.moveDown')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove} disabled={readOnly}>
              <Trash2Icon />
              {t('policies.statement.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-2 p-3 text-[0.8125rem]">
        <dt className="text-muted-foreground">
          {notActions.length > 0 ? t('policies.notActions') : t('policies.statement.actions')}
        </dt>
        <dd>
          <ChipRow values={notActions.length > 0 ? notActions : actions} />
        </dd>
        <dt className="text-muted-foreground">
          {notResources.length > 0 ? t('policies.notResources') : t('policies.statement.resources')}
        </dt>
        <dd>
          <ChipRow values={notResources.length > 0 ? notResources : resources} />
        </dd>
        <dt className="text-muted-foreground">{t('policies.statement.conditions')}</dt>
        <dd>
          {conditions.length === 0 ? (
            <span className="text-xs text-muted-foreground">{tCommon('state.none')}</span>
          ) : (
            <span className="flex flex-wrap gap-1.5">
              {conditions.map((condition) => (
                <Badge
                  key={`${condition.operator}-${condition.key}`}
                  variant="outline"
                  className="gap-1 font-mono"
                >
                  <span className="font-semibold" dir="ltr">
                    {condition.key}
                  </span>
                  <span dir="ltr">{condition.value}</span>
                </Badge>
              ))}
            </span>
          )}
        </dd>
      </dl>
    </div>
  );
}

function ChipRow({ values }: { readonly values: readonly string[] }) {
  if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="font-mono">
          <span dir="ltr">{value}</span>
        </Badge>
      ))}
    </span>
  );
}

/* ------------------------------- simulate -------------------------------- */

function SimulateCard({
  document,
  bucketNames,
  onSimulate,
  busy,
}: {
  readonly document: Record<string, unknown> | null;
  readonly bucketNames: readonly string[];
  readonly onSimulate: (
    request: { document: Record<string, unknown>; action: string; resource: string },
    onDone: (result: { decision: PolicyDecision; statementSid: string | null }) => void,
  ) => void;
  readonly busy: boolean;
}) {
  const { t } = useTranslation('pages');
  const [action, setAction] = useState('s3:GetObject');
  const [resource, setResource] = useState(
    bucketNames[0] === undefined ? 'arn:aws:s3:::bucket/key' : `arn:aws:s3:::${bucketNames[0]}/*`,
  );
  const [result, setResult] = useState<{
    decision: PolicyDecision;
    statementSid: string | null;
  } | null>(null);

  const actionOptions = useMemo<readonly ComboboxOption<string>[]>(
    () => COMMON_S3_ACTIONS.map((value) => ({ value, label: value })),
    [],
  );

  const run = () => {
    if (document === null) return;
    onSimulate({ document, action, resource }, setResult);
  };

  return (
    <SectionCard title={t('policies.simulate.title')} description={t('policies.simulate.description')}>
      <div className="flex flex-col gap-3">
        <FormField label={t('policies.simulate.action')}>
          {({ id }) => (
            <Combobox
              id={id}
              options={actionOptions}
              value={action}
              onValueChange={(next) => setAction(next ?? 's3:GetObject')}
              aria-label={t('policies.simulate.action')}
            />
          )}
        </FormField>

        <FormField label={t('policies.simulate.resource')}>
          {({ id }) => (
            <Input
              id={id}
              value={resource}
              onChange={(event) => setResource(event.target.value)}
              className="font-mono"
              dir="ltr"
              spellCheck={false}
            />
          )}
        </FormField>

        <Button variant="outline" className="w-full" onClick={run} disabled={document === null || busy}>
          {busy ? <Spinner /> : <PlayIcon />}
          {t('policies.simulate.run')}
        </Button>

        {result === null ? null : (
          <Alert variant={result.decision === 'allow' ? 'info' : 'danger'}>
            {result.decision === 'allow' ? <CircleCheckIcon /> : <CircleXIcon />}
            <AlertTitle className="flex items-center justify-between gap-2">
              {t('policies.simulate.result')}
              <Badge variant={DECISION_BADGES[result.decision]}>
                {t(`policies.decision.${result.decision satisfies PolicyDecision}`)}
              </Badge>
            </AlertTitle>
            <AlertDescription className="block text-xs">
              {t('policies.simulate.matched')}{' '}
              <span className="font-mono" dir="ltr">
                {result.statementSid ?? t('policies.simulate.noMatch')}
              </span>
            </AlertDescription>
          </Alert>
        )}

        <p className="text-xs text-muted-foreground">{t('policies.simulate.note')}</p>
      </div>
    </SectionCard>
  );
}

/* --------------------------------- import -------------------------------- */

function ImportJsonButton({ onImport }: { readonly onImport: (text: string) => void }) {
  const { t } = useTranslation('pages');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FileJsonIcon />
        {t('policies.importJson')}
      </Button>
      <ImportPolicyDialog
        open={open}
        onClose={() => setOpen(false)}
        onImported={(text) => {
          onImport(text);
          setOpen(false);
        }}
      />
    </>
  );
}

function ImportPolicyDialog({
  open,
  onClose,
  onImported,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onImported: (text: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [files, setFiles] = useState<readonly DroppedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  const read = useCallback(
    (next: readonly DroppedFile[]) => {
      setFiles(next);
      setError(null);
      setText(null);
      const first = next[0];
      if (first === undefined) return;
      void first.file.text().then(
        (content) => {
          try {
            const parsed: unknown = JSON.parse(content);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              setError(t('policies.import.notObject'));
              return;
            }
            setText(JSON.stringify(parsed, null, 2));
          } catch {
            setError(t('policies.import.notJson'));
          }
        },
        () => setError(t('policies.import.unreadable')),
      );
    },
    [t],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFiles([]);
          setError(null);
          setText(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('policies.import.title')}</DialogTitle>
          <DialogDescription>{t('policies.import.description')}</DialogDescription>
        </DialogHeader>

        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>{t('policies.import.intoEditor')}</AlertDescription>
        </Alert>

        <FileDropzone
          files={files}
          onFilesChange={read}
          accept="application/json,.json"
          maxFiles={1}
          description={t('policies.import.dropHint')}
        />

        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
        {text === null ? null : (
          <CodeEditor
            value={text}
            language="json"
            readOnly
            height="12rem"
            ariaLabel={t('policies.import.preview')}
          />
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (text !== null) onImported(text);
            }}
            disabled={text === null}
          >
            {t('policies.import.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateDialog({
  name,
  onClose,
  onConfirm,
  busy,
}: {
  readonly name: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (name: string) => void;
  readonly busy: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [value, setValue] = useState(name ?? '');

  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('policies.duplicate')}</DialogTitle>
          <DialogDescription>{t('policies.duplicateDescription')}</DialogDescription>
        </DialogHeader>
        <FormField label={t('policies.create.name')}>
          {({ id }) => (
            <Input
              id={id}
              value={value.length > 0 ? value : (name ?? '')}
              onChange={(event) => setValue(event.target.value)}
              className="font-mono"
              dir="ltr"
            />
          )}
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(value.length > 0 ? value : (name ?? ''))}
            disabled={busy}
          >
            {busy ? <Spinner /> : <CopyPlusIcon />}
            {t('policies.duplicate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
