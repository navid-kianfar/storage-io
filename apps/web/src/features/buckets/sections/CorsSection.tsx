import type { CorsRule, Server } from '@storage-io/contracts';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/app/Alert';
import { Button } from '@/components/app/Button';
import { CardContent } from '@/components/app/Card';
import { CodeEditor } from '@/components/app/CodeEditor';
import { FormActions } from '@/components/app/FormRow';
import { Spinner } from '@/components/app/Spinner';
import { toastProblem } from '@/lib/api/problems';
import { useBucketCors, useSaveBucketCors, type BucketRefParams } from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';

/**
 * CORS, edited as the JSON array S3 itself uses. A form per rule would be a
 * worse fit: the shape is small, operators copy these between buckets, and the
 * field names (`AllowedOrigins`, `MaxAgeSeconds`) are the ones in every S3
 * document they will read.
 *
 * The API's own field names are camelCase (`allowedOrigins`), so the editor shows
 * the contract's spelling rather than S3's — one vocabulary per app beats two.
 */

const CORS_EDITOR_HEIGHT = '18rem';

interface CorsCheck {
  readonly rules: readonly CorsRule[] | null;
  readonly message: string;
}

export function parseCorsRules(
  text: string,
  messages: { readonly invalidJson: string; readonly notAnArray: string },
): CorsCheck {
  const trimmed = text.trim();
  if (trimmed === '') return { rules: [], message: '' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { rules: null, message: messages.invalidJson };
  }
  if (!Array.isArray(parsed)) return { rules: null, message: messages.notAnArray };

  const rules: CorsRule[] = [];
  for (const entry of parsed) {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    if (!isObject) return { rules: null, message: messages.notAnArray };
    const record = entry as Record<string, unknown>;
    rules.push({
      allowedOrigins: stringArray(record.allowedOrigins),
      allowedMethods: stringArray(record.allowedMethods),
      allowedHeaders: stringArray(record.allowedHeaders),
      exposeHeaders: stringArray(record.exposeHeaders),
      maxAgeSeconds: typeof record.maxAgeSeconds === 'number' ? record.maxAgeSeconds : null,
    });
  }
  return { rules, message: '' };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function CorsSection({
  bucketRef,
  server,
  loading,
}: {
  readonly bucketRef: BucketRefParams;
  readonly server: Server | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');

  const availability = sectionAvailability(server, 'cors', loading);
  const cors = useBucketCors(bucketRef, availability === 'ready');
  const savedText = useMemo(
    () => (cors.data === undefined ? '' : JSON.stringify(cors.data.rules, null, 2)),
    [cors.data],
  );

  return (
    <SectionCard
      id="cors"
      title={t('bucket.cors.title')}
      description={t('bucket.cors.description')}
      availability={availability === 'ready' && cors.data === undefined ? 'loading' : availability}
      provider={server?.provider}
    >
      {cors.data === undefined ? null : (
        <CorsForm key={savedText} bucketRef={bucketRef} savedText={savedText} />
      )}
    </SectionCard>
  );
}

/** Mounted with the server's answer as its initial state and keyed by it. */
function CorsForm({
  bucketRef,
  savedText,
}: {
  readonly bucketRef: BucketRefParams;
  readonly savedText: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const save = useSaveBucketCors();

  const [text, setText] = useState(savedText);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== savedText;

  const messages = {
    invalidJson: t('bucket.cors.invalidJson'),
    notAnArray: t('bucket.cors.notAnArray'),
  };

  function submit(): void {
    if (save.isPending) return;
    const check = parseCorsRules(text, messages);
    if (check.rules === null) {
      setError(check.message);
      toast.error(t('bucket.cors.failed'), { description: check.message });
      return;
    }
    setError(null);
    save.mutate(
      { ref: bucketRef, body: { rules: [...check.rules] } },
      {
        onSuccess: () => toast.success(t('bucket.cors.saved')),
        onError: (mutationError) => toastProblem(mutationError, tCommon, t('bucket.cors.failed')),
      },
    );
  }

  return (
    <>
      <CardContent className="flex flex-col gap-3">
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <CodeEditor
          value={text}
          onValueChange={(next) => {
            setText(next);
            setError(null);
          }}
          language="json"
          height={CORS_EDITOR_HEIGHT}
          placeholder="[]"
          ariaLabel={t('bucket.cors.editorLabel')}
        />
        <p className="text-[0.8125rem] text-muted-foreground">{t('bucket.cors.hint')}</p>
      </CardContent>

      <FormActions>
        <Button
          variant="outline"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setText(savedText);
            setError(null);
            toast.info(t('bucket.discard'));
          }}
        >
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!dirty || save.isPending}>
          {save.isPending ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </FormActions>
    </>
  );
}
