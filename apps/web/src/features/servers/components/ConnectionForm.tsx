import { ChevronRightIcon, EyeIcon, EyeOffIcon, GlobeIcon, XIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FileDropzone,
  FormField,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  OptionRow,
  Select,
  Switch,
  type DroppedFile,
  type SelectOption,
} from '@/components/app';
import {
  HEALTH_INTERVAL_CHOICES,
  providerUsesAdminEndpoint,
  providerUsesAdminToken,
  type ConnectionFormValues,
} from '@/features/servers/connection-schema';
import { cn } from '@/lib/utils';

/**
 * The one connection form in the app. The first-run wizard, the Add-server
 * dialog, the Edit-connection dialog and the server's Connection tab all render
 * this — which is why it takes the form rather than owning it: each of those
 * submits to a different endpoint and each has its own footer.
 *
 * What it does own: the reveal toggle on the secret, the CA-bundle file read, and
 * which advanced fields make sense for the chosen provider — a Garage server is
 * asked for an admin token, an R2 bucket for neither.
 */

const MAX_CA_PEM_BYTES = 32_768;

export function ConnectionForm({
  form,
  /** Editing keeps the stored secret when the field is left blank. */
  mode,
  className,
}: {
  readonly form: UseFormReturn<ConnectionFormValues>;
  readonly mode: 'create' | 'edit';
  readonly className?: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [secretVisible, setSecretVisible] = useState(false);
  const [caFiles, setCaFiles] = useState<readonly DroppedFile[]>([]);

  const provider = form.watch('provider');
  const caPem = form.watch('caPem');
  const errors = form.formState.errors;

  /**
   * A validation message is an i18n key when it came from this form's schema and a
   * plain sentence when it came from the API or from a contract schema; `t` with the
   * raw string as its fallback handles both without the caller having to know which.
   */
  const fieldError = (message: string | undefined): string | undefined =>
    message === undefined ? undefined : t(message, { defaultValue: message });

  const intervalOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      HEALTH_INTERVAL_CHOICES.map((seconds) => ({
        value: String(seconds),
        label: t(`servers.connection.interval.${seconds}`),
      })),
    [t],
  );

  const readCaBundle = useCallback(
    (files: readonly DroppedFile[]) => {
      setCaFiles(files);
      const first = files[0];
      if (first === undefined) {
        form.setValue('caPem', '', { shouldDirty: true });
        return;
      }
      const read = async () => {
        const text = await first.file.text();
        if (text.length > MAX_CA_PEM_BYTES) {
          toast.error(t('servers.connection.caTooLarge'));
          setCaFiles([]);
          return;
        }
        form.setValue('caPem', text, { shouldDirty: true, shouldValidate: true });
      };
      read().catch(() => {
        toast.error(tCommon('error.unexpected'));
        setCaFiles([]);
      });
    },
    [form, t, tCommon],
  );

  const clearCaBundle = useCallback(() => {
    setCaFiles([]);
    form.setValue('caPem', '', { shouldDirty: true });
  }, [form]);

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t('servers.connection.name')}
          hint={t('servers.connection.nameHint')}
          error={fieldError(errors.name?.message)}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              placeholder="minio-prod-01"
              {...form.register('name')}
            />
          )}
        </FormField>

        <FormField
          label={t('servers.connection.region')}
          error={fieldError(errors.region?.message)}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              placeholder="us-east-1"
              {...form.register('region')}
            />
          )}
        </FormField>

        <FormField
          label={t('servers.connection.endpoint')}
          hint={t('servers.connection.endpointHint')}
          error={fieldError(errors.endpoint?.message)}
          className="sm:col-span-2"
        >
          {({ id, describedBy, invalid }) => (
            <InputGroup>
              <InputGroupAddon>
                <GlobeIcon />
              </InputGroupAddon>
              <InputGroupInput
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                className="ltr-isolate font-mono"
                placeholder="https://s3.prod.acme.local:9000"
                {...form.register('endpoint')}
              />
            </InputGroup>
          )}
        </FormField>

        <FormField
          label={t('servers.connection.accessKeyId')}
          error={fieldError(errors.accessKeyId?.message)}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="ltr-isolate font-mono"
              {...form.register('accessKeyId')}
            />
          )}
        </FormField>

        <FormField
          label={t('servers.connection.secret')}
          hint={mode === 'edit' ? t('servers.connection.secretKeepHint') : undefined}
          error={fieldError(errors.secretAccessKey?.message)}
        >
          {({ id, describedBy, invalid }) => (
            <InputGroup>
              <InputGroupInput
                id={id}
                type={secretVisible ? 'text' : 'password'}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                className="ltr-isolate font-mono"
                placeholder={mode === 'edit' ? '••••••••••••' : undefined}
                {...form.register('secretAccessKey')}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setSecretVisible((visible) => !visible)}
                  aria-label={
                    secretVisible ? tCommon('form.hideSecret') : tCommon('form.showSecret')
                  }
                >
                  {secretVisible ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          )}
        </FormField>
      </div>

      <Collapsible>
        <CollapsibleTrigger className="group/adv flex w-fit items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRightIcon
            className="size-4 transition-transform group-data-[state=open]/adv:rotate-90 flip-rtl"
            aria-hidden="true"
          />
          {t('servers.connection.advanced')}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 rounded-lg border px-4">
          <OptionRow
            label={t('servers.connection.pathStyle')}
            hint={t('servers.connection.pathStyleHint')}
          >
              <Switch
                checked={form.watch('pathStyle')}
                onCheckedChange={(checked) =>
                  form.setValue('pathStyle', checked, { shouldDirty: true })
                }
                aria-label={t('servers.connection.pathStyle')}
              />
          </OptionRow>
          <OptionRow
            label={t('servers.connection.tlsVerify')}
            hint={t('servers.connection.tlsVerifyHint')}
          >
              <Switch
                checked={form.watch('tlsVerify')}
                onCheckedChange={(checked) =>
                  form.setValue('tlsVerify', checked, { shouldDirty: true })
                }
                aria-label={t('servers.connection.tlsVerify')}
              />
          </OptionRow>
          <div className="border-b py-3 last:border-b-0">
            <div className="flex flex-col">
              <span className="text-[0.8125rem] font-medium">
                {t('servers.connection.caBundle')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('servers.connection.caBundleHint')}
              </span>
            </div>
            {caPem.length > 0 ? (
              <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {caFiles[0]?.relativePath ?? t('servers.connection.caBundleStored')}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={clearCaBundle}
                  aria-label={tCommon('action.removeFile')}
                >
                  <XIcon />
                </Button>
              </div>
            ) : (
              <FileDropzone
                className="mt-2"
                files={caFiles}
                onFilesChange={readCaBundle}
                accept=".pem,.crt,.cer,application/x-pem-file"
                maxFiles={1}
                maxSizeBytes={MAX_CA_PEM_BYTES}
                description={t('servers.connection.caBundleDrop')}
              />
            )}
          </div>

          {providerUsesAdminEndpoint(provider) ? (
            <OptionRow
              label={t('servers.connection.adminEndpoint')}
              hint={t('servers.connection.adminEndpointHint')}
            >
                <Input
                  className="ltr-isolate w-60 font-mono"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t('servers.connection.adminEndpoint')}
                  aria-invalid={errors.adminEndpoint !== undefined}
                  {...form.register('adminEndpoint')}
                />
            </OptionRow>
          ) : null}

          {providerUsesAdminEndpoint(provider) ? (
            <OptionRow
              label={t('servers.connection.iamEndpoint')}
              hint={t('servers.connection.iamEndpointHint')}
            >
                <Input
                  className="ltr-isolate w-60 font-mono"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t('servers.connection.iamEndpoint')}
                  aria-invalid={errors.iamEndpoint !== undefined}
                  {...form.register('iamEndpoint')}
                />
            </OptionRow>
          ) : null}

          {providerUsesAdminToken(provider) ? (
            <OptionRow
              label={t('servers.connection.adminToken')}
              hint={t('servers.connection.adminTokenHint')}
            >
                <Input
                  type="password"
                  className="ltr-isolate w-60 font-mono"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t('servers.connection.adminToken')}
                  aria-invalid={errors.adminToken !== undefined}
                  {...form.register('adminToken')}
                />
            </OptionRow>
          ) : null}

          <OptionRow
            label={t('servers.connection.healthInterval')}
            hint={t('servers.connection.healthIntervalHint')}
          >
              <Select
                options={intervalOptions}
                value={String(form.watch('healthIntervalSec'))}
                onValueChange={(next) =>
                  form.setValue('healthIntervalSec', Number(next), { shouldDirty: true })
                }
                size="sm"
                className="w-40"
                aria-label={t('servers.connection.healthInterval')}
              />
          </OptionRow>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
