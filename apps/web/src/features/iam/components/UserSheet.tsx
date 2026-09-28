import type { AccessKey, S3User } from '@storage-io/contracts';
import {
  BanIcon,
  CalendarClockIcon,
  CopyIcon,
  EllipsisIcon,
  InfoIcon,
  KeyRoundIcon,
  LockIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  ShieldIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AccessKeyStatusBadge,
  Alert,
  AlertDescription,
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  DateTime,
  Dash,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  InitialsAvatar,
  ListRow,
  Num,
  OptionRow,
  ProviderMark,
  RelativeTime,
  SectionCard,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  UserStatusBadge,
  type ComboboxOption,
} from '@/components/app';
import {
  useDeleteAccessKey,
  useIamGroups,
  useIamPolicies,
  useIamUser,
  useSetIamUserGroups,
  useSetIamUserPolicies,
  useSetIamUserStatus,
  useUpdateAccessKey,
  type UserRef,
} from '@/features/iam/api';
import { EditAccessKeyDialog } from '@/features/iam/components/EditAccessKeyDialog';
import { useApiError } from '@/lib/api/useApiError';
import { useDialogs } from '@/lib/dialogs/useDialogs';

/**
 * Everything about one S3 user, in four tabs.
 *
 * The sheet is deliberately not a form with a Save button: each control is its own
 * write, applied on the server immediately, because that is what the endpoints are
 * — `PATCH …/users/:name`, `PUT …/policies`, `PUT …/groups` are three separate
 * server-side operations and pretending they commit together would be a lie the
 * first time one of them failed.
 *
 * Policies inherited from a group are listed with the group they come from and
 * cannot be detached here: detaching one means editing that group, which is a
 * different object and a different blast radius.
 */

export function UserSheet({
  user,
  onClose,
  onDelete,
}: {
  readonly user: S3User;
  readonly onClose: () => void;
  readonly onDelete: (user: S3User) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const { t: tDomain } = useTranslation('domain');
  const apiError = useApiError();
  const dialogs = useDialogs();

  const ref: UserRef = { serverId: user.serverId, name: user.name };
  const detail = useIamUser(ref);
  const policies = useIamPolicies({ serverId: user.serverId });
  const groups = useIamGroups({ serverId: user.serverId });

  const setStatus = useSetIamUserStatus();
  const setPolicies = useSetIamUserPolicies();
  const setGroups = useSetIamUserGroups();
  const updateKey = useUpdateAccessKey();
  const deleteKey = useDeleteAccessKey();

  const [policyToAttach, setPolicyToAttach] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<AccessKey | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<AccessKey | null>(null);

  const current = detail.data ?? null;
  const ownPolicies = current?.policies ?? user.policies;
  const inherited = current?.inheritedPolicies ?? [];
  const keys = current?.accessKeys ?? [];
  const memberGroups = current?.groups ?? user.groups;

  const arn = `arn:aws:iam:::user/${user.name}`;

  const policyOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (policies.data?.items ?? [])
        .filter((entry) => !ownPolicies.includes(entry.name))
        .map((entry) => ({
          value: entry.name,
          label: entry.name,
          description: entry.description ?? (entry.builtIn ? t('users.sheet.builtIn') : undefined),
        })),
    [ownPolicies, policies.data, t],
  );

  const attachPolicy = () => {
    if (policyToAttach === null) return;
    setPolicies.mutate(
      { ...ref, policies: [...ownPolicies, policyToAttach] },
      {
        onSuccess: () => {
          toast.success(t('users.toast.policyAttached'), { description: policyToAttach });
          setPolicyToAttach(null);
        },
        onError: (error) => apiError.toastError(error, t('users.toast.policyFailed')),
      },
    );
  };

  const detachPolicy = (name: string) => {
    setPolicies.mutate(
      { ...ref, policies: ownPolicies.filter((entry) => entry !== name) },
      {
        onSuccess: () => toast.success(t('users.toast.policyDetached'), { description: name }),
        onError: (error) => apiError.toastError(error, t('users.toast.policyFailed')),
      },
    );
  };

  const toggleGroup = (name: string, member: boolean) => {
    const next = member ? [...memberGroups, name] : memberGroups.filter((entry) => entry !== name);
    setGroups.mutate(
      { ...ref, groups: next },
      {
        onSuccess: () =>
          toast.success(member ? t('users.toast.groupJoined') : t('users.toast.groupLeft'), {
            description: name,
          }),
        onError: (error) => apiError.toastError(error, t('users.toast.groupFailed')),
      },
    );
  };

  const toggleEnabled = (enabled: boolean) => {
    setStatus.mutate(
      { ...ref, status: enabled ? 'enabled' : 'disabled' },
      {
        onSuccess: () =>
          toast.success(enabled ? t('users.toast.enabled') : t('users.toast.disabled'), {
            description: user.name,
          }),
        onError: (error) => apiError.toastError(error, t('users.toast.statusFailed')),
      },
    );
  };

  const setKeyStatus = (key: AccessKey, status: 'active' | 'disabled') => {
    updateKey.mutate(
      { serverId: key.serverId, accessKeyId: key.accessKeyId, status },
      {
        onSuccess: () =>
          toast.success(status === 'active' ? t('keys.toast.enabled') : t('keys.toast.disabled'), {
            description: key.accessKeyId,
          }),
        onError: (error) => apiError.toastError(error, t('keys.toast.updateFailed')),
      },
    );
  };

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => toast.success(tCommon('action.copied'), { description: value }),
      () => toast.error(t('keys.copyFailed')),
    );
  };

  const statusValue = current?.status ?? user.status;

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="flex-row items-center gap-3 border-b">
            <InitialsAvatar name={user.name} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col">
              <SheetTitle className="truncate font-mono text-sm">{user.name}</SheetTitle>
              <SheetDescription className="flex items-center gap-1.5 text-xs">
                <ProviderMark provider={user.provider} size="sm" />
                <span className="truncate font-mono">{user.serverName}</span>
              </SheetDescription>
            </div>
            <UserStatusBadge status={statusValue} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('users.actionsFor', { name: user.name })}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    dialogs.open('create-access-key', { server: user.serverId, user: user.name })
                  }
                >
                  <KeyRoundIcon />
                  {t('keys.create.action')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copy(arn)}>
                  <CopyIcon />
                  {t('users.copyArn')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(user)}>
                  <Trash2Icon />
                  {tCommon('action.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SheetHeader>

          <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList
              className="w-full rounded-none border-b px-4 pt-2"
              aria-label={t('users.sheet.tabs')}
            >
              <TabsTrigger value="overview" className="flex-1">
                {t('users.sheet.overview')}
              </TabsTrigger>
              <TabsTrigger value="policies" className="flex-1">
                {t('users.sheet.policies')}
                <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-xs">
                  <Num value={ownPolicies.length + inherited.length} />
                </span>
              </TabsTrigger>
              <TabsTrigger value="keys" className="flex-1">
                {t('users.sheet.accessKeys')}
                <span className="num ms-1.5 rounded-full bg-muted px-1.5 text-xs">
                  <Num value={keys.length} />
                </span>
              </TabsTrigger>
              <TabsTrigger value="groups" className="flex-1">
                {t('users.sheet.groups')}
              </TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <TabsContent value="overview" className="mt-0 flex flex-col gap-4">
                <SectionCard flush>
                  <OptionRow label={t('users.sheet.enabled')} hint={t('users.sheet.enabledHint')}>
                    <Switch
                      checked={statusValue === 'enabled'}
                      disabled={statusValue === 'unknown' || setStatus.isPending}
                      onCheckedChange={toggleEnabled}
                      aria-label={t('users.sheet.enabled')}
                    />
                  </OptionRow>
                </SectionCard>

                <SectionCard title={t('users.sheet.details')}>
                  <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-2 text-[0.8125rem]">
                    <dt className="text-muted-foreground">{t('users.column.server')}</dt>
                    <dd className="font-mono">{user.serverName}</dd>
                    <dt className="text-muted-foreground">{t('users.sheet.provider')}</dt>
                    <dd>{tDomain(`provider.${user.provider}`)}</dd>
                    <dt className="text-muted-foreground">{t('users.sheet.arn')}</dt>
                    <dd className="truncate font-mono text-xs" dir="ltr">
                      {arn}
                    </dd>
                    <dt className="text-muted-foreground">{t('users.sheet.created')}</dt>
                    <dd>
                      {user.createdAt === null ? <Dash /> : <DateTime value={user.createdAt} />}
                    </dd>
                    <dt className="text-muted-foreground">{t('users.column.lastActivity')}</dt>
                    <dd>
                      {user.lastActivityAt === null ? (
                        <Dash />
                      ) : (
                        <RelativeTime value={user.lastActivityAt} />
                      )}
                    </dd>
                    <dt className="text-muted-foreground">{t('users.column.accessKeys')}</dt>
                    <dd className="num">
                      <Num value={keys.length} />
                    </dd>
                    <dt className="text-muted-foreground">{t('users.column.groups')}</dt>
                    <dd className="font-mono text-xs">
                      {memberGroups.length === 0 ? <Dash /> : memberGroups.join(', ')}
                    </dd>
                  </dl>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => copy(arn)}>
                    <CopyIcon />
                    {t('users.copyArn')}
                  </Button>
                </SectionCard>
              </TabsContent>

              <TabsContent value="policies" className="mt-0 flex flex-col gap-4">
                <SectionCard flush>
                  {detail.isLoading ? (
                    <div className="flex flex-col gap-2 p-4">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : ownPolicies.length === 0 && inherited.length === 0 ? (
                    <EmptyState icon={ShieldIcon} title={t('users.sheet.noPolicies')} />
                  ) : (
                    <>
                      {ownPolicies.map((name) => (
                        <ListRow
                          key={name}
                          media={
                            <ShieldCheckIcon className="size-4 text-primary" aria-hidden="true" />
                          }
                          title={<span className="font-mono">{name}</span>}
                          subtitle={descriptionOf(policies.data?.items ?? [], name)}
                          trailing={
                            <span className="flex items-center gap-2">
                              {isBuiltIn(policies.data?.items ?? [], name) ? (
                                <Badge variant="secondary">
                                  <LockIcon />
                                  {t('users.sheet.builtIn')}
                                </Badge>
                              ) : (
                                <Badge variant="outline">{t('users.sheet.custom')}</Badge>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={setPolicies.isPending}
                                onClick={() => detachPolicy(name)}
                              >
                                {t('users.sheet.detach')}
                              </Button>
                            </span>
                          }
                        />
                      ))}
                      {inherited.map((entry) => (
                        <ListRow
                          key={`${entry.fromGroup}/${entry.policy}`}
                          media={
                            <UsersIcon
                              className="size-4 text-muted-foreground"
                              aria-hidden="true"
                            />
                          }
                          title={<span className="font-mono">{entry.policy}</span>}
                          subtitle={t('users.sheet.inheritedFrom', { group: entry.fromGroup })}
                          trailing={<Badge variant="outline">{t('users.sheet.inherited')}</Badge>}
                        />
                      ))}
                    </>
                  )}
                </SectionCard>

                <SectionCard
                  title={t('users.sheet.attachTitle')}
                  description={t('users.sheet.attachDescription')}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Combobox
                      options={policyOptions}
                      value={policyToAttach}
                      onValueChange={setPolicyToAttach}
                      placeholder={t('users.sheet.selectPolicy')}
                      className="min-w-0 flex-1"
                      aria-label={t('users.sheet.selectPolicy')}
                    />
                    <Button
                      onClick={attachPolicy}
                      disabled={policyToAttach === null || setPolicies.isPending}
                    >
                      <PlusIcon />
                      {t('users.sheet.attach')}
                    </Button>
                  </div>
                </SectionCard>

                <Alert variant="info">
                  <InfoIcon />
                  <AlertDescription>{t('users.sheet.effectiveNote')}</AlertDescription>
                </Alert>
              </TabsContent>

              <TabsContent value="keys" className="mt-0 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t('users.sheet.keyCount', { count: keys.length })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      dialogs.open('create-access-key', { server: user.serverId, user: user.name })
                    }
                  >
                    <PlusIcon />
                    {t('keys.create.action')}
                  </Button>
                </div>

                <SectionCard flush>
                  {detail.isLoading ? (
                    <div className="flex flex-col gap-2 p-4">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                    </div>
                  ) : keys.length === 0 ? (
                    <EmptyState icon={KeyRoundIcon} title={t('users.sheet.noKeys')} />
                  ) : (
                    keys.map((key) => (
                      <ListRow
                        key={key.accessKeyId}
                        media={<KeyRoundIcon className="size-4 text-primary" aria-hidden="true" />}
                        title={
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono" dir="ltr">
                              {key.accessKeyId}
                            </span>
                            <AccessKeyStatusBadge status={key.status} />
                          </span>
                        }
                        subtitle={
                          <span className="flex flex-wrap items-center gap-1.5">
                            {key.name === null ? null : <span>{key.name}</span>}
                            {key.expiresAt === null ? (
                              <span>{tCommon('state.never')}</span>
                            ) : (
                              <span>
                                {t('users.sheet.expires')} <RelativeTime value={key.expiresAt} />
                              </span>
                            )}
                            {key.lastUsedAt === null ? null : (
                              <span>
                                · {t('users.sheet.lastUsed')}{' '}
                                <RelativeTime value={key.lastUsedAt} />
                              </span>
                            )}
                          </span>
                        }
                        trailing={
                          <span className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={key.status === 'expired'}
                              onClick={() =>
                                dialogs.open('rotate-access-key', {
                                  server: key.serverId,
                                  key: key.accessKeyId,
                                })
                              }
                            >
                              <RotateCwIcon />
                              {t('keys.rotate.action')}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t('keys.actionsFor', { id: key.accessKeyId })}
                                >
                                  <EllipsisIcon />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => copy(key.accessKeyId)}>
                                  <CopyIcon />
                                  {t('keys.copyId')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setEditKey(key)}>
                                  <CalendarClockIcon />
                                  {t('keys.edit.action')}
                                </DropdownMenuItem>
                                {key.status === 'disabled' ? (
                                  <DropdownMenuItem onSelect={() => setKeyStatus(key, 'active')}>
                                    <PlayIcon />
                                    {t('keys.enable')}
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onSelect={() => setKeyStatus(key, 'disabled')}
                                    disabled={key.status === 'expired'}
                                  >
                                    <BanIcon />
                                    {t('keys.disable')}
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => setKeyToDelete(key)}
                                >
                                  <Trash2Icon />
                                  {t('users.sheet.deleteKey')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        }
                      />
                    ))
                  )}
                </SectionCard>

                <Alert variant="warning">
                  <TriangleAlertIcon />
                  <AlertDescription>{t('users.sheet.secretOnceNote')}</AlertDescription>
                </Alert>
              </TabsContent>

              <TabsContent value="groups" className="mt-0 flex flex-col gap-4">
                <SectionCard flush>
                  {groups.isLoading ? (
                    <div className="flex flex-col gap-2 p-4">
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : (groups.data?.items ?? []).length === 0 ? (
                    <EmptyState icon={UsersIcon} title={t('users.sheet.noGroups')} />
                  ) : (
                    (groups.data?.items ?? []).map((group) => (
                      <OptionRow
                        key={group.name}
                        label={<span className="font-mono">{group.name}</span>}
                        hint={t('users.sheet.groupHint', {
                          count: group.members.length,
                          policies:
                            group.policies.length === 0
                              ? tCommon('state.none')
                              : group.policies.join(', '),
                        })}
                      >
                        <Switch
                          checked={memberGroups.includes(group.name)}
                          disabled={setGroups.isPending}
                          onCheckedChange={(next) => toggleGroup(group.name, next)}
                          aria-label={group.name}
                        />
                      </OptionRow>
                    ))
                  )}
                </SectionCard>
                <p className="text-xs text-muted-foreground">
                  {t('users.sheet.groupsScopeNote', { server: user.serverName })}
                </p>
              </TabsContent>
            </div>
          </Tabs>

          <SheetFooter className="flex-row items-center gap-2 border-t">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <InfoIcon className="size-3.5" aria-hidden="true" />
              {t('users.sheet.appliedImmediately')}
            </span>
            <Button variant="outline" size="sm" className="ms-auto" onClick={onClose}>
              {tCommon('action.close')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {editKey === null ? null : (
        <EditAccessKeyDialog accessKey={editKey} expirySupported onClose={() => setEditKey(null)} />
      )}

      <ConfirmDialog
        open={keyToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setKeyToDelete(null);
        }}
        title={t('keys.delete.title')}
        description={t('keys.delete.description')}
        confirmLabel={tCommon('action.delete')}
        destructive
        busy={deleteKey.isPending}
        onConfirm={() => {
          const key = keyToDelete;
          if (key === null) return;
          deleteKey.mutate(
            { serverId: key.serverId, accessKeyId: key.accessKeyId },
            {
              onSuccess: () => {
                toast.success(t('keys.toast.deleted'), { description: key.accessKeyId });
                setKeyToDelete(null);
              },
              onError: (error) => apiError.toastError(error, t('keys.toast.deleteFailed')),
            },
          );
        }}
      />
    </>
  );
}

function descriptionOf(
  items: readonly { readonly name: string; readonly description: string | null }[],
  name: string,
): string | undefined {
  return items.find((entry) => entry.name === name)?.description ?? undefined;
}

function isBuiltIn(
  items: readonly { readonly name: string; readonly builtIn: boolean }[],
  name: string,
): boolean {
  return items.find((entry) => entry.name === name)?.builtIn ?? false;
}
