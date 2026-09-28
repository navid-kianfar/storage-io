import type { TestServerResponse } from '@storage-io/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { PlugZapIcon } from 'lucide-react';
import { useCallback, useEffect } from 'react';
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
  Skeleton,
  Spinner,
} from '@/components/app';
import { ConnectionForm } from '@/features/servers/components/ConnectionForm';
import { ServerChecks } from '@/features/servers/components/ServerChecks';
import {
  applyConnectionFieldErrors,
  connectionFormSchema,
  connectionValuesOf,
  emptyConnectionValues,
  toCreateServerRequest,
  toUpdateServerRequest,
  type ConnectionFormValues,
} from '@/features/servers/connection-schema';
import { useServer, useTestConnection, useUpdateServer } from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

/**
 * Edit a saved connection, from a server card's menu. The server page's
 * Connection tab renders the same form inline — this dialog exists so the action
 * is reachable from the list and from a link, and so the same edit is one
 * component in both places.
 *
 * The secret is never prefilled and an empty secret means "keep the stored one":
 * that is the contract's PATCH behaviour, and the hint under the field says so.
 * "Test before saving" tests the *edited* values, not the stored ones.
 */
export function EditServerDialog({ params, onClose }: DialogProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const serverId = params.server ?? '';
  const server = useServer(serverId);
  const update = useUpdateServer();
  const test = useTestConnection();

  const result: TestServerResponse | undefined = test.data;
  const testError = test.isError ? apiError.message(test.error) : undefined;

  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    mode: 'onBlur',
    defaultValues: emptyConnectionValues('minio'),
  });

  // The form is filled once the server arrives. `reset` rather than
  // `defaultValues` because the query resolves after the first render.
  const loaded = server.data;
  useEffect(() => {
    if (loaded === undefined) return;
    form.reset(connectionValuesOf(loaded));
  }, [form, loaded]);

  const runChecks = useCallback(() => {
    test.mutate(toCreateServerRequest(form.getValues()));
  }, [form, test]);

  const onSubmit = form.handleSubmit((values) => {
    update.mutate(
      { serverId, body: toUpdateServerRequest(values) },
      {
        onSuccess: (updated) => {
          toast.success(t('servers.toast.updated'), { description: updated.name });
          onClose();
        },
        onError: (error) => {
          if (applyConnectionFieldErrors(error, form.setError)) return;
          apiError.toastError(error, t('servers.toast.updateFailed'));
        },
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-4rem)] gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-(--card-pad)">
          <DialogTitle>{t('servers.edit.title')}</DialogTitle>
          <DialogDescription>{t('servers.edit.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-4 p-(--card-pad)">
            {server.isLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : server.isError ? (
              <p className="text-sm text-destructive">{apiError.message(server.error)}</p>
            ) : (
              <ConnectionForm form={form} mode="edit" />
            )}

            {result === undefined && !test.isPending && testError === undefined ? null : (
              <ServerChecks
                checks={result?.checks}
                running={test.isPending}
                error={testError}
                capabilities={result?.capabilities}
                version={result?.version}
                bucketCount={result?.bucketCount}
              />
            )}
          </div>

          <DialogFooter className="items-center justify-between border-t p-(--card-pad) sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={runChecks}
              disabled={test.isPending || server.data === undefined}
            >
              {test.isPending ? <Spinner /> : <PlugZapIcon />}
              {t('servers.edit.testBeforeSaving')}
            </Button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {tCommon('action.cancel')}
              </Button>
              <Button type="submit" disabled={update.isPending || server.data === undefined}>
                {update.isPending ? <Spinner /> : null}
                {tCommon('action.save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

registerDialog('edit-server', EditServerDialog);
