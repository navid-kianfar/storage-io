import type { PolicyVersion } from '@storage-io/contracts';
import { HistoryIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  DateTime,
  EmptyState,
  SectionCard,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from '@/components/app';
import { useIamPolicyVersions, useRestoreIamPolicyVersion, type PolicyRef } from '@/features/iam/api';
import { useApiError } from '@/lib/api/useApiError';

/**
 * Every version storage-io has seen of this policy, newest first, with the
 * document each one held.
 *
 * The history is the app's own — snapshots taken on every PUT made through
 * storage-io — so it exists even on providers that keep no policy history. A
 * version changed on the server directly is therefore *not* here, and the sheet
 * says so rather than implying it is a complete audit trail.
 */
export function PolicyVersionsSheet({
  policy,
  onClose,
  onRestored,
}: {
  readonly policy: PolicyRef;
  readonly onClose: () => void;
  readonly onRestored: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const apiError = useApiError();

  const versions = useIamPolicyVersions(policy);
  const restore = useRestoreIamPolicyVersion();
  const [toRestore, setToRestore] = useState<PolicyVersion | null>(null);

  const items = versions.data?.items ?? [];

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle className="text-sm">{t('policies.versions.title')}</SheetTitle>
            <SheetDescription className="font-mono">{policy.name}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {versions.isError ? (
              <EmptyState
                icon={HistoryIcon}
                title={tCommon('state.error')}
                description={apiError.message(versions.error)}
              />
            ) : versions.isLoading ? (
              <>
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </>
            ) : items.length === 0 ? (
              <EmptyState
                icon={HistoryIcon}
                title={t('policies.versions.empty')}
                description={t('policies.versions.emptyHint')}
              />
            ) : (
              items.map((version) => (
                <SectionCard
                  key={version.id}
                  title={<DateTime value={version.createdAt} />}
                  description={version.note ?? t('policies.versions.noNote')}
                  action={
                    <Button variant="outline" size="sm" onClick={() => setToRestore(version)}>
                      <RotateCcwIcon />
                      {t('policies.versions.restore')}
                    </Button>
                  }
                >
                  <CodeEditor
                    value={JSON.stringify(version.document, null, 2)}
                    language="json"
                    readOnly
                    height="12rem"
                    ariaLabel={t('policies.versions.documentOf', {
                      at: version.createdAt,
                    })}
                  />
                </SectionCard>
              ))
            )}

            <p className="text-xs text-muted-foreground">{t('policies.versions.scopeNote')}</p>
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={toRestore !== null}
        onOpenChange={(open) => {
          if (!open) setToRestore(null);
        }}
        title={t('policies.versions.restoreTitle')}
        description={t('policies.versions.restoreDescription')}
        confirmLabel={t('policies.versions.restore')}
        busy={restore.isPending}
        onConfirm={() => {
          const version = toRestore;
          if (version === null) return;
          restore.mutate(
            { ...policy, versionId: version.id },
            {
              onSuccess: () => {
                toast.success(t('policies.toast.restored'), { description: policy.name });
                setToRestore(null);
                onRestored();
              },
              onError: (error) => apiError.toastError(error, t('policies.toast.restoreFailed')),
            },
          );
        }}
      />
    </>
  );
}
