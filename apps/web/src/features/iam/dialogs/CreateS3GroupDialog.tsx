import { UsersIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  OptionRow,
  ScrollArea,
  SectionCard,
  Skeleton,
  Spinner,
  Switch,
  type ComboboxOption,
} from '@/components/app';
import { useIamGroups, useIamPolicies, useIamUsers, useUpsertIamGroup } from '@/features/iam/api';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * Create or edit a group: `?dialog=create-s3-group`, with `d_server` and — when
 * editing — `d_group`.
 *
 * One component for both because the endpoint is the same shape: `POST` creates,
 * `PATCH` replaces, and both take the full member and policy set. Sending the full
 * set rather than a delta is the contract's choice and the safer one: two
 * administrators adding members at once cannot silently drop each other's work
 * without one of them seeing a stale list first.
 */

const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,126}[A-Za-z0-9]$/;
const MEMBER_PAGE_SIZE = 500;

export function CreateS3GroupDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const servers = useServers();
  const upsert = useUpsertIamGroup();

  const existingName = params.group ?? null;
  const [serverId, setServerId] = useState<string | null>(params.server ?? null);

  const groups = useIamGroups(serverId === null ? {} : { serverId });
  const policies = useIamPolicies(serverId === null ? {} : { serverId });
  const users = useIamUsers({
    page: 1,
    pageSize: MEMBER_PAGE_SIZE,
    ...(serverId === null ? {} : { serverId }),
  });

  const existing = useMemo(
    () =>
      existingName === null
        ? undefined
        : (groups.data?.items ?? []).find(
            (group) => group.name === existingName && group.serverId === serverId,
          ),
    [existingName, groups.data, serverId],
  );

  // Keyed by the group so the form's initial state is the group's own data without
  // an effect copying server data into state on every render.
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existingName === null ? t('users.groups.createTitle') : t('users.groups.editTitle')}
          </DialogTitle>
          <DialogDescription>{t('users.groups.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <FormField label={t('users.create.server')}>
          {({ id }) => (
            <Combobox
              id={id}
              options={(servers.data?.items ?? [])
                .filter((server) => server.capabilities.iamGroups === 'supported')
                .map<ComboboxOption<string>>((server) => ({
                  value: server.id,
                  label: server.name,
                  description: server.endpoint,
                  disabled: server.status === 'offline',
                }))}
              value={serverId}
              onValueChange={setServerId}
              placeholder={t('keys.create.pickServer')}
              disabled={existingName !== null}
              aria-label={t('users.create.server')}
            />
          )}
        </FormField>

        {serverId === null ? (
          <p className="text-sm text-muted-foreground">{t('users.groups.pickServerFirst')}</p>
        ) : groups.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <GroupForm
            key={`${serverId}/${existingName ?? 'new'}`}
            serverId={serverId}
            existingName={existingName}
            initialName={existing?.name ?? ''}
            initialMembers={existing?.members ?? []}
            initialPolicies={existing?.policies ?? []}
            initialEnabled={(existing?.status ?? 'enabled') === 'enabled'}
            memberOptions={(users.data?.items ?? [])
              .filter((user) => user.serverId === serverId)
              .map((user) => user.name)}
            policyOptions={(policies.data?.items ?? []).map((policy) => ({
              name: policy.name,
              builtIn: policy.builtIn,
              description: policy.description,
            }))}
            busy={upsert.isPending}
            onSave={(values) =>
              upsert.mutate(
                {
                  serverId,
                  ...(existingName === null ? {} : { existingName }),
                  name: values.name,
                  members: [...values.members],
                  policies: [...values.policies],
                  status: values.enabled ? 'enabled' : 'disabled',
                },
                {
                  onSuccess: () => {
                    toast.success(
                      existingName === null
                        ? t('users.toast.groupCreated')
                        : t('users.toast.groupSaved'),
                      { description: values.name },
                    );
                    onClose();
                  },
                  onError: (error) => apiError.toastError(error, t('users.toast.groupSaveFailed')),
                },
              )
            }
            onCancel={onClose}
            cancelLabel={tCommon('action.cancel')}
            saveLabel={existingName === null ? t('users.groups.create') : tCommon('action.save')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface GroupValues {
  readonly name: string;
  readonly members: readonly string[];
  readonly policies: readonly string[];
  readonly enabled: boolean;
}

function GroupForm({
  existingName,
  initialName,
  initialMembers,
  initialPolicies,
  initialEnabled,
  memberOptions,
  policyOptions,
  busy,
  onSave,
  onCancel,
  cancelLabel,
  saveLabel,
}: {
  readonly serverId: string;
  readonly existingName: string | null;
  readonly initialName: string;
  readonly initialMembers: readonly string[];
  readonly initialPolicies: readonly string[];
  readonly initialEnabled: boolean;
  readonly memberOptions: readonly string[];
  readonly policyOptions: readonly {
    readonly name: string;
    readonly builtIn: boolean;
    readonly description: string | null;
  }[];
  readonly busy: boolean;
  readonly onSave: (values: GroupValues) => void;
  readonly onCancel: () => void;
  readonly cancelLabel: string;
  readonly saveLabel: string;
}) {
  const { t } = useTranslation('pages');
  const [name, setName] = useState(initialName);
  const [members, setMembers] = useState<readonly string[]>(initialMembers);
  const [policies, setPolicies] = useState<readonly string[]>(initialPolicies);
  const [enabled, setEnabled] = useState(initialEnabled);

  const nameValid = GROUP_NAME_PATTERN.test(name);

  const toggle = (
    list: readonly string[],
    setList: (next: readonly string[]) => void,
    value: string,
    on: boolean,
  ) => setList(on ? [...list, value] : list.filter((entry) => entry !== value));

  return (
    <>
      <FormField
        label={t('users.groups.name')}
        hint={t('users.groups.nameHint')}
        error={name.length > 0 && !nameValid ? t('users.groups.nameInvalid') : undefined}
      >
        {({ id, invalid }) => (
          <Input
            id={id}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="font-mono"
            dir="ltr"
            disabled={existingName !== null}
            aria-invalid={invalid}
          />
        )}
      </FormField>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('users.groups.members')}</span>
        <SectionCard flush>
          {memberOptions.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {t('users.groups.noMembers')}
            </p>
          ) : (
            <ScrollArea className="max-h-44">
              {memberOptions.map((member) => (
                <label
                  key={member}
                  className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <Checkbox
                    checked={members.includes(member)}
                    onCheckedChange={(checked) =>
                      toggle(members, setMembers, member, checked === true)
                    }
                  />
                  <span className="truncate font-mono text-[0.8125rem]">{member}</span>
                </label>
              ))}
            </ScrollArea>
          )}
        </SectionCard>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium">{t('users.create.policies')}</span>
        <SectionCard flush>
          {policyOptions.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {t('users.create.noPolicies')}
            </p>
          ) : (
            <ScrollArea className="max-h-44">
              {policyOptions.map((policy) => (
                <label
                  key={policy.name}
                  className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <Checkbox
                    checked={policies.includes(policy.name)}
                    onCheckedChange={(checked) =>
                      toggle(policies, setPolicies, policy.name, checked === true)
                    }
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[0.8125rem]">{policy.name}</span>
                    {policy.description === null ? null : (
                      <span className="truncate text-xs text-muted-foreground">
                        {policy.description}
                      </span>
                    )}
                  </span>
                  {policy.builtIn ? (
                    <Badge variant="secondary">{t('users.sheet.builtIn')}</Badge>
                  ) : null}
                </label>
              ))}
            </ScrollArea>
          )}
        </SectionCard>
      </div>

      <SectionCard flush>
        <OptionRow label={t('users.groups.enabled')} hint={t('users.groups.enabledHint')}>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('users.groups.enabled')}
          />
        </OptionRow>
      </SectionCard>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          onClick={() => onSave({ name, members, policies, enabled })}
          disabled={!nameValid || busy}
        >
          {busy ? <Spinner /> : <UsersIcon />}
          {saveLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

registerDialog('create-s3-group', CreateS3GroupDialog);
