import { ArrowUpDownIcon, EyeIcon, FileJsonIcon, GlobeIcon, UploadIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  ChoiceCards,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Spinner,
  type ChoiceOption,
  type ComboboxOption,
} from '@/components/app';
import { useBuckets } from '@/features/buckets/api';
import { usePutIamPolicy } from '@/features/iam/api';
import {
  POLICY_TEMPLATES,
  templateDocument,
  type PolicyTemplate,
} from '@/features/iam/policyTemplates';
import { useServers } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * Create a policy from a template: `?dialog=create-policy`, with `d_server` and
 * `d_template` accepted so the "New policy" split button can open it already on the
 * right template.
 *
 * The bucket picker is what makes the templates useful. A template that writes
 * `arn:aws:s3:::bucket-name/*` and leaves the operator to find and replace it is a
 * template that produces a policy granting nothing, discovered later.
 */

const TEMPLATE_ICONS: Readonly<Record<PolicyTemplate, typeof EyeIcon>> = {
  'read-only': EyeIcon,
  'read-write': ArrowUpDownIcon,
  'upload-only': UploadIcon,
  'public-read': GlobeIcon,
  blank: FileJsonIcon,
};

const POLICY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,126}[A-Za-z0-9]$/;
const BUCKET_PICKER_PAGE_SIZE = 500;

function isTemplate(value: unknown): value is PolicyTemplate {
  return typeof value === 'string' && (POLICY_TEMPLATES as readonly string[]).includes(value);
}

export function CreatePolicyDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const servers = useServers();
  const buckets = useBuckets({ sort: 'name', page: 1, pageSize: BUCKET_PICKER_PAGE_SIZE });
  const putPolicy = usePutIamPolicy();

  const [serverId, setServerId] = useState<string | null>(params.server ?? null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<PolicyTemplate>(
    isTemplate(params.template) ? params.template : 'read-only',
  );
  const [bucket, setBucket] = useState<string | null>(params.bucket ?? null);

  const serverOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (servers.data?.items ?? [])
        .filter((server) => server.capabilities.iamPolicies === 'supported')
        .map((server) => ({
          value: server.id,
          label: server.name,
          description:
            server.status === 'offline' ? t('users.create.serverOffline') : server.endpoint,
          disabled: server.status === 'offline',
        })),
    [servers.data, t],
  );

  const bucketOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      (buckets.data?.items ?? [])
        .filter((entry) => serverId !== null && entry.serverId === serverId)
        .map((entry) => ({ value: entry.name, label: entry.name })),
    [buckets.data, serverId],
  );

  const templateOptions = useMemo<readonly ChoiceOption<PolicyTemplate>[]>(
    () =>
      POLICY_TEMPLATES.map((value) => {
        const Icon = TEMPLATE_ICONS[value];
        return {
          value,
          label: t(`policies.template.${value}`),
          description: t(`policies.templateHint.${value}`),
          media: <Icon className="size-4 text-primary" aria-hidden="true" />,
        };
      }),
    [t],
  );

  const needsBucket = template !== 'blank';
  const nameValid = POLICY_NAME_PATTERN.test(name);
  const canSubmit = serverId !== null && nameValid && (!needsBucket || bucket !== null);

  const submit = () => {
    if (serverId === null) return;
    const document = templateDocument(template, bucket ?? 'bucket-name');
    putPolicy.mutate(
      {
        serverId,
        name,
        document: document as unknown as Record<string, unknown>,
        ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t('policies.toast.created'), { description: name });
          onClose();
        },
        onError: (error) => apiError.toastError(error, t('policies.toast.createFailed')),
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('policies.create.title')}</DialogTitle>
          <DialogDescription>{t('policies.create.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <FormField
            label={t('policies.create.name')}
            hint={t('policies.create.nameHint')}
            error={name.length > 0 && !nameValid ? t('policies.create.nameInvalid') : undefined}
          >
            {({ id, invalid }) => (
              <Input
                id={id}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="font-mono"
                dir="ltr"
                autoComplete="off"
                aria-invalid={invalid}
                placeholder="reports-read"
              />
            )}
          </FormField>

          <FormField label={t('users.create.server')}>
            {({ id }) => (
              <Combobox
                id={id}
                options={serverOptions}
                value={serverId}
                onValueChange={(next) => {
                  setServerId(next);
                  setBucket(null);
                }}
                placeholder={t('keys.create.pickServer')}
                aria-label={t('users.create.server')}
              />
            )}
          </FormField>

          <FormField
            label={t('policies.create.descriptionLabel')}
            optionalText={` (${tCommon('form.optional')})`}
          >
            {({ id }) => (
              <Input
                id={id}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t('policies.create.descriptionPlaceholder')}
              />
            )}
          </FormField>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">{t('policies.create.template')}</span>
            <ChoiceCards
              options={templateOptions}
              value={template}
              onValueChange={setTemplate}
              orientation="grid"
              columns={2}
              aria-label={t('policies.create.template')}
            />
          </div>

          {needsBucket ? (
            <FormField label={t('policies.create.bucket')} hint={t('policies.create.bucketHint')}>
              {({ id }) => (
                <Combobox
                  id={id}
                  options={bucketOptions}
                  value={bucket}
                  onValueChange={setBucket}
                  placeholder={t('jobs.wizard.pickBucket')}
                  disabled={serverId === null}
                  aria-label={t('policies.create.bucket')}
                />
              )}
            </FormField>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit || putPolicy.isPending}>
            {putPolicy.isPending ? <Spinner /> : null}
            {tCommon('action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

registerDialog('create-policy', CreatePolicyDialog);
