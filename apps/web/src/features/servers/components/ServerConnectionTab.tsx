import type { Server, TestServerResponse } from '@storage-io/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { PlugZapIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Num,
  OptionRow,
  SectionCard,
  ServerStatusBadge,
  Spinner,
} from '@/components/app';
import { ConnectionForm } from '@/features/servers/components/ConnectionForm';
import { ServerChecks } from '@/features/servers/components/ServerChecks';
import {
  applyConnectionFieldErrors,
  connectionFormSchema,
  connectionValuesOf,
  toCreateServerRequest,
  toUpdateServerRequest,
  type ConnectionFormValues,
} from '@/features/servers/connection-schema';
import {
  useDeleteServer,
  useTestConnection,
  useTestServer,
  useUpdateServer,
} from '@/features/servers/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * The saved connection, editable in place, plus the verification list and the
 * danger zone. The same `ConnectionForm` the wizard uses — the only difference is
 * the footer and that the secret stays blank to keep the stored one.
 *
 * The verification list runs against the *saved* connection while the form is
 * clean and against the edited values once it is dirty, because those are two
 * different questions and the operator is asking whichever one matches what they
 * are looking at.
 */
export function ServerConnectionTab({ server }: { readonly server: Server }) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();

  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionFormSchema),
    mode: 'onBlur',
    defaultValues: connectionValuesOf(server),
  });

  const update = useUpdateServer();
  const testSaved = useTestServer();
  const testDraft = useTestConnection();
  const remove = useDeleteServer();

  const [removing, setRemoving] = useState(false);

  /**
   * The check result is the mutation's own state rather than a copy in `useState`:
   * one fewer thing to keep in step, and it means the mount-time run below does
   * not call `setState` from an effect.
   *
   * Two mutations can have answered, so the most recently submitted one wins.
   */
  const latest =
    (testDraft.submittedAt ?? 0) > (testSaved.submittedAt ?? 0) ? testDraft : testSaved;
  const result: TestServerResponse | undefined = latest.data;
  const testError = latest.isError ? apiError.message(latest.error) : undefined;

  // Re-syncs when a check or an SSE event refreshes the server underneath, but
  // never over an edit in progress.
  const dirty = form.formState.isDirty;
  useEffect(() => {
    if (dirty) return;
    form.reset(connectionValuesOf(server));
  }, [dirty, form, server]);

  const runChecks = useCallback(() => {
    if (form.formState.isDirty) {
      testDraft.mutate(toCreateServerRequest(form.getValues()));
      return;
    }
    testSaved.mutate(server.id);
  }, [form, server.id, testDraft, testSaved]);

  // The Connection tab is the one place an operator expects the checks to have
  // already run, so opening it starts them once. Radix unmounts an inactive tab
  // panel, so "mounted" and "the operator opened this tab" are the same event.
  const testSavedMutate = testSaved.mutate;
  useEffect(() => {
    testSavedMutate(server.id);
  }, [server.id, testSavedMutate]);

  const testing = testSaved.isPending || testDraft.isPending;

  const onSubmit = form.handleSubmit((values) => {
    update.mutate(
      { serverId: server.id, body: toUpdateServerRequest(values) },
      {
        onSuccess: (updated) => {
          toast.success(t('servers.toast.updated'), {
            description: t('servers.toast.updatedDetail', {
              name: updated.name,
              ms: updated.latencyMs ?? 0,
            }),
          });
          form.reset(connectionValuesOf(updated));
          // The URL carries the server's id, so a rename changes nothing about
          // the address — there is nothing to navigate to any more.
        },
        onError: (error) => {
          if (applyConnectionFieldErrors(error, form.setError)) return;
          apiError.toastError(error, t('servers.toast.updateFailed'));
        },
      },
    );
  });

  const confirmRemove = useCallback(() => {
    remove.mutate(server.id, {
      onSuccess: () => {
        toast.success(t('servers.toast.removed'), { description: server.name });
        setRemoving(false);
        void navigate({ to: '/servers' });
      },
      onError: (error) => apiError.toastError(error, t('servers.toast.removeFailed')),
    });
  }, [apiError, navigate, remove, server.id, server.name, t]);

  return (
    <div className="flex flex-col gap-(--gap)">
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="flex-row items-start gap-3 border-b px-(--card-pad) py-(--card-pad) [.border-b]:pb-(--card-pad)">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm">{t('server.connection.title')}</CardTitle>
            <CardDescription className="mt-0.5 text-xs">
              {t('server.connection.description')}
            </CardDescription>
          </div>
          <ServerStatusBadge status={server.status} />
        </CardHeader>
        <form onSubmit={onSubmit} noValidate>
          <CardContent className="p-(--card-pad)">
            <ConnectionForm form={form} mode="edit" />
          </CardContent>
          <div className="flex flex-wrap items-center gap-2 border-t px-(--card-pad) py-3">
            <Button type="button" variant="ghost" onClick={runChecks} disabled={testing}>
              {testing ? <Spinner /> : <PlugZapIcon />}
              {t('servers.edit.testBeforeSaving')}
            </Button>
            <span className="ms-auto" />
            <Button
              type="button"
              variant="outline"
              onClick={() => form.reset(connectionValuesOf(server))}
              disabled={!form.formState.isDirty || update.isPending}
            >
              {tCommon('action.cancel')}
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
              {update.isPending ? <Spinner /> : null}
              {tCommon('action.save')}
            </Button>
          </div>
        </form>
      </Card>

      <SectionCard
        title={t('server.verification.title')}
        description={
          form.formState.isDirty
            ? t('server.verification.draftDescription')
            : t('server.verification.description')
        }
        action={
          <Button variant="ghost" size="sm" onClick={runChecks} disabled={testing}>
            {testing ? <Spinner /> : <RefreshCwIcon />}
            {t('servers.wizard.runAgain')}
          </Button>
        }
      >
        <ServerChecks
          checks={result?.checks}
          running={testing}
          error={testError}
          capabilities={result?.capabilities}
          version={result?.version}
          bucketCount={result?.bucketCount}
        />
      </SectionCard>

      <Card className="gap-0 overflow-hidden border-destructive/30 py-0">
        <CardHeader className="flex-col items-start gap-0 border-b px-(--card-pad) py-(--card-pad) [.border-b]:pb-(--card-pad)">
          <CardTitle className="text-sm text-destructive">{t('server.danger.title')}</CardTitle>
          <CardDescription className="mt-0.5 text-xs">
            {t('server.danger.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-(--card-pad) py-1">
          <OptionRow
            label={t('server.danger.removeTitle')}
            hint={t('server.danger.removeHint')}
          >
              <Button variant="destructive" onClick={() => setRemoving(true)}>
                <Trash2Icon />
                {t('servers.card.remove')}
              </Button>
          </OptionRow>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        destructive
        title={t('server.danger.confirmTitle')}
        description={t('server.danger.confirmDescription')}
        confirmValue={server.name}
        confirmValueLabel={t('servers.remove.confirmLabel')}
        confirmLabel={t('servers.card.remove')}
        busy={remove.isPending}
        onConfirm={confirmRemove}
      >
        <ul className="flex list-inside list-disc flex-col gap-1 text-sm text-muted-foreground">
          <li>
            <Num value={server.counts.buckets} /> {t('server.danger.buckets')}
          </li>
          {server.counts.users === null ? null : (
            <li>
              <Num value={server.counts.users} /> {t('server.danger.users')}
            </li>
          )}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
