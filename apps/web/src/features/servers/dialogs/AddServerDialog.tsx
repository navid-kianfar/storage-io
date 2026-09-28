import type { Provider, TestServerResponse } from '@storage-io/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { CheckIcon, PlugZapIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  StepList,
  StepPanels,
  useStepper,
  type StepDefinition,
} from '@/components/app';
import { ConnectionForm } from '@/features/servers/components/ConnectionForm';
import { ProviderPicker } from '@/features/servers/components/ProviderPicker';
import { ServerChecks } from '@/features/servers/components/ServerChecks';
import {
  applyConnectionFieldErrors,
  connectionFormSchema,
  emptyConnectionValues,
  toCreateServerRequest,
  type ConnectionFormValues,
} from '@/features/servers/connection-schema';
import { useCreateServer, useTestConnection } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * Add a server: provider → connection → verify, exactly as the concept's
 * `dlg-add` draws it, and with the same three components the first-run wizard
 * uses — the point of building them in `features/servers/components` once.
 *
 * The verify step runs `POST /servers/test` against the *unsaved* connection, so
 * a wrong endpoint or a missing admin API is found before anything is stored. The
 * finish button stays disabled until that run has happened and no check failed:
 * saving a connection the API just said is broken is the one thing this wizard
 * exists to prevent.
 */
export function AddServerDialog({ onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();

  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    mode: 'onBlur',
    defaultValues: emptyConnectionValues('minio'),
  });

  const test = useTestConnection();
  const create = useCreateServer();

  /** The check result is the mutation's own state; nothing is copied into useState. */
  const result: TestServerResponse | undefined = test.data;
  const testError = test.isError ? apiError.message(test.error) : undefined;

  const provider = form.watch('provider');

  const hasFailure = result !== undefined && result.checks.some((check) => check.status === 'fail');
  const verified = result !== undefined && !hasFailure;

  const steps = useMemo<readonly StepDefinition[]>(
    () => [
      { id: 'provider', label: t('servers.wizard.providerStep') },
      // Not gated on `isValid`: the Next button validates on press and surfaces the
      // field errors, rather than sitting disabled with nothing explaining why.
      { id: 'connection', label: t('servers.wizard.connectionStep') },
      { id: 'verify', label: t('servers.wizard.verifyStep'), canContinue: verified },
    ],
    [t, verified],
  );

  const stepper = useStepper(steps);

  const runChecks = useCallback(() => {
    test.mutate(toCreateServerRequest(form.getValues()));
  }, [form, test]);

  /** Moving off the connection step is what starts the verification. */
  const onNext = useCallback(async () => {
    if (stepper.current.id === 'connection') {
      const valid = await form.trigger();
      if (!valid) return;
      stepper.next();
      runChecks();
      return;
    }
    stepper.next();
  }, [form, runChecks, stepper]);

  const onFinish = useCallback(() => {
    const body = toCreateServerRequest(form.getValues());
    create.mutate(body, {
      onSuccess: (server) => {
        toast.success(t('servers.toast.added'), {
          description: t('servers.toast.addedDetail', {
            name: server.name,
            count: server.counts.buckets,
          }),
        });
        onClose();
        void navigate({ to: '/servers/$server', params: { server: server.name } });
      },
      onError: (error) => {
        const matched = applyConnectionFieldErrors(error, form.setError);
        if (matched) {
          // The bad field is on the connection step, so go back to it.
          stepper.goTo(1);
          return;
        }
        apiError.toastError(error, t('servers.toast.addFailed'));
      },
    });
  }, [apiError, create, form, navigate, onClose, stepper, t]);

  const onProviderChange = useCallback(
    (next: Provider) => {
      form.reset({ ...emptyConnectionValues(next), name: form.getValues('name') });
      // A different provider invalidates the previous run's answer.
      test.reset();
    },
    [form, test],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-4rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-(--card-pad)">
          <DialogTitle>{t('servers.wizard.title')}</DialogTitle>
          <DialogDescription>{t('servers.wizard.description')}</DialogDescription>
          <StepList stepper={stepper} className="mt-2" />
        </DialogHeader>

        <div className="p-(--card-pad)">
          <StepPanels
            stepper={stepper}
            panels={{
              provider: <ProviderPicker value={provider} onValueChange={onProviderChange} />,
              connection: <ConnectionForm form={form} mode="create" />,
              verify: (
                <ServerChecks
                  checks={result?.checks}
                  running={test.isPending}
                  error={testError}
                  capabilities={result?.capabilities}
                  version={result?.version}
                  bucketCount={result?.bucketCount}
                />
              ),
            }}
          />
        </div>

        <DialogFooter className="items-center justify-between border-t p-(--card-pad) sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={stepper.back}
            disabled={stepper.isFirst || create.isPending}
          >
            {tCommon('action.back')}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {tCommon('action.cancel')}
            </Button>
            {stepper.isLast ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={runChecks}
                  disabled={test.isPending}
                >
                  <PlugZapIcon />
                  {t('servers.wizard.runAgain')}
                </Button>
                <Button
                  type="button"
                  onClick={onFinish}
                  disabled={!verified || create.isPending || test.isPending}
                >
                  <CheckIcon />
                  {t('servers.wizard.finish')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={() => {
                  void onNext();
                }}
                disabled={!stepper.canContinue}
              >
                {tCommon('action.next')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

registerDialog('add-server', AddServerDialog);
