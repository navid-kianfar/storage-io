import type { CreatedKey } from '@storage-io/contracts';
import { CheckIcon, CopyIcon, FileDownIcon, KeyRoundIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  CopyField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/app';
import { CREDENTIALS_CSV_HEADERS, SNIPPET_KINDS, buildSnippet, credentialsCsvRow } from '@/features/iam/snippets';
import { downloadCsv, toCsv } from '@/lib/csv/csv';

/**
 * The one moment a secret exists in the browser.
 *
 * It is shown once, it is never persisted, and the dialog will not let the
 * operator leave until they say they have stored it — not as ceremony, but because
 * the next screen cannot get it back for them. Closing by Escape or the overlay is
 * disabled for the same reason: an accidental click would cost a key.
 */

const SNIPPET_ALIAS_FALLBACK = 's3';

function LabelledCopy({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.8125rem] font-medium">{label}</span>
      <CopyField value={value} label={label} />
    </div>
  );
}

export function SecretRevealDialog({
  created,
  serverName,
  onDone,
}: {
  readonly created: CreatedKey;
  readonly serverName: string;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const [stored, setStored] = useState(false);
  const [kind, setKind] = useState<string>(SNIPPET_KINDS[0]);

  const alias = serverName.length > 0 ? serverName : SNIPPET_ALIAS_FALLBACK;
  const snippets = useMemo(
    () =>
      SNIPPET_KINDS.map((value) => ({
        value,
        text: buildSnippet(value, { created, alias }),
      })),
    [alias, created],
  );

  const downloadCredentials = () => {
    const csv = toCsv([...CREDENTIALS_CSV_HEADERS], [credentialsCsvRow(created)]);
    downloadCsv(csv, `${created.accessKey.accessKeyId}-credentials.csv`);
    toast.success(t('keys.secret.downloaded'));
  };

  const copySnippet = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(tCommon('action.copied')),
      () => toast.error(t('keys.secret.copyFailed')),
    );
  };

  return (
    <Dialog open>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <span className="grid size-9 place-items-center rounded-lg bg-success/15 text-success">
            <KeyRoundIcon className="size-4.5" aria-hidden="true" />
          </span>
          <DialogTitle>{t('keys.secret.title')}</DialogTitle>
          <DialogDescription>{t('keys.secret.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <LabelledCopy
            label={t('keys.secret.accessKeyId')}
            value={created.accessKey.accessKeyId}
          />
          <LabelledCopy
            label={t('keys.secret.secretAccessKey')}
            value={created.secretAccessKey}
          />

          <Tabs value={kind} onValueChange={setKind}>
            <TabsList aria-label={t('keys.secret.snippets')}>
              {SNIPPET_KINDS.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(`keys.secret.snippet.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {snippets.map((snippet) => (
              <TabsContent key={snippet.value} value={snippet.value} className="mt-2">
                <div className="relative">
                  <pre
                    dir="ltr"
                    className="overflow-x-auto rounded-lg border bg-muted/40 p-3 pe-11 font-mono text-[0.6875rem] leading-relaxed"
                  >
                    {snippet.text}
                  </pre>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-2 end-2"
                    onClick={() => copySnippet(snippet.text)}
                    aria-label={t('keys.secret.copySnippet', {
                      kind: t(`keys.secret.snippet.${snippet.value}`),
                    })}
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </TabsContent>
            ))}
          </Tabs>

          <label className="flex items-start gap-2.5">
            <Checkbox
              checked={stored}
              onCheckedChange={(checked) => setStored(checked === true)}
              className="mt-0.5"
            />
            <span className="text-[0.8125rem]">{t('keys.secret.acknowledge')}</span>
          </label>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="outline" onClick={downloadCredentials}>
            <FileDownIcon />
            {t('keys.secret.downloadCsv')}
          </Button>
          <Button type="button" disabled={!stored} onClick={onDone}>
            <CheckIcon />
            {tCommon('action.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
