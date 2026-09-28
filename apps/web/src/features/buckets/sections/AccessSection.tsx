import type { Server } from '@storage-io/contracts';
import { BracesIcon, CircleCheckIcon, GlobeIcon, ShieldIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/app/Alert';
import { Badge } from '@/components/app/Badge';
import { Button } from '@/components/app/Button';
import { CardContent } from '@/components/app/Card';
import { CodeEditor } from '@/components/app/CodeEditor';
import { FormActions } from '@/components/app/FormRow';
import { SegmentedControl } from '@/components/app/SegmentedControl';
import { Spinner } from '@/components/app/Spinner';
import { toastProblem } from '@/lib/api/problems';
import {
  useBucketAccess,
  useBucketPolicy,
  useSaveBucketAccess,
  useSaveBucketPolicy,
  type BucketRefParams,
} from '../api';
import { SectionCard, sectionAvailability } from '../components/SectionCard';

/**
 * Access policy: the two presets, and the JSON document behind them.
 *
 * `private` and `public-read` go through `PUT …/access`, which lets the API write
 * the canonical policy for that level. `custom` goes through `PUT …/policy` with
 * whatever the operator typed. Picking a preset therefore replaces a custom
 * policy — the alert says so before it happens.
 *
 * "Validate" is deliberately local: `POST /iam/policies/validate` validates *IAM*
 * policy documents, and a bucket policy is a different shape. What can be checked
 * without guessing is checked — valid JSON, an object, a Statement array with
 * Effect and Action on every statement — and nothing is claimed beyond that.
 */

const POLICY_EDITOR_HEIGHT = '22rem';
type Preset = 'private' | 'public-read' | 'custom';

interface PolicyCheck {
  readonly valid: boolean;
  readonly message: string;
  readonly statements: number;
}

export function checkBucketPolicy(
  text: string,
  messages: {
    readonly invalidJson: string;
    readonly notAnObject: string;
    readonly missingStatement: string;
  },
): PolicyCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false, message: messages.invalidJson, statements: 0 };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, message: messages.notAnObject, statements: 0 };
  }
  const statement = (parsed as { Statement?: unknown }).Statement;
  if (!Array.isArray(statement) || statement.length === 0) {
    return { valid: false, message: messages.missingStatement, statements: 0 };
  }
  for (const entry of statement) {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    if (!isObject) return { valid: false, message: messages.missingStatement, statements: 0 };
    const record = entry as Record<string, unknown>;
    if (record.Effect === undefined || record.Action === undefined) {
      return { valid: false, message: messages.missingStatement, statements: 0 };
    }
  }
  return { valid: true, message: '', statements: statement.length };
}

export function AccessSection({
  bucketRef,
  server,
  loading,
}: {
  readonly bucketRef: BucketRefParams;
  readonly server: Server | undefined;
  readonly loading: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  const availability = sectionAvailability(server, 'bucketPolicy', loading);
  const ready = availability === 'ready';
  const accessQuery = useBucketAccess(bucketRef, ready);
  const policyQuery = useBucketPolicy(bucketRef, ready);

  const access = accessQuery.data;
  const policy = policyQuery.data?.policy ?? access?.policy ?? null;
  const waiting = access === undefined || policyQuery.data === undefined;

  const policyText = useMemo(
    () => (policy === null ? '' : JSON.stringify(policy, null, 2)),
    [policy],
  );

  return (
    <SectionCard
      id="access"
      title={t('bucket.access.title')}
      description={t('bucket.access.description')}
      availability={ready && waiting ? 'loading' : availability}
      provider={server?.provider}
      action={
        access === undefined ? null : (
          <Badge variant="secondary">
            <ShieldIcon aria-hidden="true" />
            {tDomain(`access.${access.access}`)}
          </Badge>
        )
      }
    >
      {waiting ? null : (
        <AccessForm
          key={`${access.access}:${policyText}`}
          bucketRef={bucketRef}
          savedPreset={access.access}
          savedPolicyText={policyText}
        />
      )}
    </SectionCard>
  );
}

/** Mounted with the server's answer as its initial state and keyed by it. */
function AccessForm({
  bucketRef,
  savedPreset,
  savedPolicyText,
}: {
  readonly bucketRef: BucketRefParams;
  readonly savedPreset: Preset;
  readonly savedPolicyText: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const saveAccess = useSaveBucketAccess();
  const savePolicy = useSaveBucketPolicy();

  const [preset, setPreset] = useState<Preset>(savedPreset);
  const [text, setText] = useState(savedPolicyText);
  const [validated, setValidated] = useState<PolicyCheck | null>(null);

  const busy = saveAccess.isPending || savePolicy.isPending;
  const dirty = preset !== savedPreset || text !== savedPolicyText;

  const messages = {
    invalidJson: t('bucket.access.invalidJson'),
    notAnObject: t('bucket.access.notAnObject'),
    missingStatement: t('bucket.access.missingStatement'),
  };

  function validate(): void {
    const result = checkBucketPolicy(text, messages);
    setValidated(result);
    if (result.valid) {
      toast.success(t('bucket.access.valid'), {
        description: t('bucket.access.validDetail', { count: result.statements }),
      });
      return;
    }
    toast.error(t('bucket.access.invalid'), { description: result.message });
  }

  function submit(): void {
    if (busy) return;
    const failureTitle = t('bucket.access.failed');

    if (preset !== 'custom') {
      saveAccess.mutate(
        { ref: bucketRef, body: { access: preset } },
        {
          onSuccess: () => toast.success(t('bucket.access.saved')),
          onError: (error) => toastProblem(error, tCommon, failureTitle),
        },
      );
      return;
    }

    const check = checkBucketPolicy(text, messages);
    setValidated(check);
    if (!check.valid) {
      toast.error(t('bucket.access.invalid'), { description: check.message });
      return;
    }

    savePolicy.mutate(
      { ref: bucketRef, body: { policy: JSON.parse(text) as Record<string, unknown> } },
      {
        onSuccess: () => toast.success(t('bucket.access.saved')),
        onError: (error) => toastProblem(error, tCommon, failureTitle),
      },
    );
  }

  return (
    <>
      <CardContent className="flex flex-col gap-4">
        <SegmentedControl
          options={[
            {
              value: 'private',
              label: t('bucket.access.private'),
              icon: <ShieldIcon aria-hidden="true" />,
            },
            {
              value: 'public-read',
              label: t('bucket.access.publicRead'),
              icon: <GlobeIcon aria-hidden="true" />,
            },
            {
              value: 'custom',
              label: t('bucket.access.custom'),
              icon: <BracesIcon aria-hidden="true" />,
            },
          ]}
          value={preset}
          onValueChange={(next) => {
            setPreset(next);
            setValidated(null);
          }}
          aria-label={t('bucket.access.preset')}
        />

        {preset === 'public-read' ? (
          <Alert variant="warning">
            <AlertTitle>{t('bucket.access.publicWarning')}</AlertTitle>
            <AlertDescription>{t('bucket.access.publicWarningDetail')}</AlertDescription>
          </Alert>
        ) : null}

        {validated !== null && !validated.valid ? (
          <Alert variant="destructive">
            <AlertDescription>{validated.message}</AlertDescription>
          </Alert>
        ) : null}

        <CodeEditor
          value={text}
          onValueChange={
            preset === 'custom'
              ? (next) => {
                  setText(next);
                  setValidated(null);
                }
              : undefined
          }
          readOnly={preset !== 'custom'}
          language="json"
          height={POLICY_EDITOR_HEIGHT}
          placeholder="{}"
          ariaLabel={t('bucket.access.editorLabel')}
        />
      </CardContent>

      <FormActions>
        <Button
          variant="ghost"
          className="me-auto"
          onClick={validate}
          disabled={preset !== 'custom'}
        >
          <CircleCheckIcon />
          {t('bucket.access.validate')}
        </Button>
        <Button
          variant="outline"
          disabled={!dirty || busy}
          onClick={() => {
            setPreset(savedPreset);
            setText(savedPolicyText);
            setValidated(null);
            toast.info(t('bucket.discard'));
          }}
        >
          {tCommon('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={!dirty || busy}>
          {busy ? <Spinner /> : null}
          {tCommon('action.save')}
        </Button>
      </FormActions>
    </>
  );
}
