import {
  CONDITION_OPERATORS,
  type ConditionBlock,
  type ConditionOperator,
  type PolicyStatement,
} from '@storage-io/contracts';
import { PlusIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  SectionCard,
  SegmentedControl,
  type ComboboxOption,
  type SegmentedOption,
} from '@/components/app';
import { COMMON_S3_ACTIONS, asList } from '@/features/iam/policyTemplates';

/**
 * One statement, edited as a form rather than as JSON.
 *
 * Actions and resources are comboboxes that *suggest* rather than constrain: the
 * suggestions come from the common S3 namespace and from the operator's own bucket
 * list, but anything can be typed, because a closed list would refuse `admin:*` on
 * MinIO or `sts:*` on Ceph and the operator would go back to the JSON tab anyway.
 *
 * Conditions are limited to the four operators the shared evaluator implements
 * (`StringEquals`, `StringLike`, `IpAddress`, `Bool`). A condition this app cannot
 * evaluate would make the simulator silently wrong, so the visual editor does not
 * offer one — the JSON tab still accepts it, and the simulator says when it met an
 * operator it does not know.
 */

const EFFECTS = ['Allow', 'Deny'] as const;
type Effect = (typeof EFFECTS)[number];

export interface StatementEditorProps {
  readonly statement: PolicyStatement | null;
  readonly index: number;
  readonly bucketSuggestions: readonly string[];
  readonly onSave: (statement: PolicyStatement) => void;
  readonly onClose: () => void;
}

interface ConditionRow {
  readonly operator: ConditionOperator;
  readonly key: string;
  readonly value: string;
}

function conditionRows(condition: ConditionBlock | undefined): readonly ConditionRow[] {
  if (condition === undefined) return [];
  const rows: ConditionRow[] = [];
  for (const [operator, pairs] of Object.entries(condition)) {
    if (!(CONDITION_OPERATORS as readonly string[]).includes(operator)) continue;
    for (const [key, value] of Object.entries(pairs)) {
      rows.push({
        operator: operator as ConditionOperator,
        key,
        value: Array.isArray(value) ? value.map(String).join(', ') : String(value),
      });
    }
  }
  return rows;
}

function conditionBlock(rows: readonly ConditionRow[]): ConditionBlock | undefined {
  const usable = rows.filter((row) => row.key.trim().length > 0);
  if (usable.length === 0) return undefined;
  const block: Record<string, Record<string, string | boolean | string[]>> = {};
  for (const row of usable) {
    const bucket = (block[row.operator] ??= {});
    const values = row.value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
    if (row.operator === 'Bool') {
      bucket[row.key.trim()] = values[0] === 'true';
      continue;
    }
    bucket[row.key.trim()] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return block;
}

export function StatementEditorDialog({
  statement,
  index,
  bucketSuggestions,
  onSave,
  onClose,
}: StatementEditorProps) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();

  const [sid, setSid] = useState(statement?.Sid ?? `Statement${String(index + 1)}`);
  const [effect, setEffect] = useState<Effect>(statement?.Effect === 'Deny' ? 'Deny' : 'Allow');
  const [actions, setActions] = useState<readonly string[]>(() => asList(statement?.Action));
  const [resources, setResources] = useState<readonly string[]>(() => asList(statement?.Resource));
  const [conditions, setConditions] = useState<readonly ConditionRow[]>(() =>
    conditionRows(statement?.Condition),
  );

  const effectOptions = useMemo<readonly SegmentedOption<Effect>[]>(
    () => EFFECTS.map((value) => ({ value, label: t(`policies.effect.${value}`) })),
    [t],
  );

  const actionOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      COMMON_S3_ACTIONS.filter((action) => !actions.includes(action)).map((action) => ({
        value: action,
        label: action,
      })),
    [actions],
  );

  const resourceOptions = useMemo<readonly ComboboxOption<string>[]>(
    () =>
      bucketSuggestions
        .filter((resource) => !resources.includes(resource))
        .map((resource) => ({ value: resource, label: resource })),
    [bucketSuggestions, resources],
  );

  const conditionOperatorOptions = useMemo<readonly ComboboxOption<ConditionOperator>[]>(
    () => CONDITION_OPERATORS.map((operator) => ({ value: operator, label: operator })),
    [],
  );

  const canSave = actions.length > 0 && resources.length > 0 && sid.trim().length > 0;

  const save = () => {
    const condition = conditionBlock(conditions);
    onSave({
      Sid: sid.trim(),
      Effect: effect,
      Action: [...actions],
      Resource: [...resources],
      ...(condition === undefined ? {} : { Condition: condition }),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {statement === null
              ? t('policies.statement.addTitle')
              : t('policies.statement.editTitle')}
          </DialogTitle>
          <DialogDescription>{t('policies.statement.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('policies.statement.sid')} hint={t('policies.statement.sidHint')}>
              {({ id }) => (
                <Input
                  id={id}
                  value={sid}
                  onChange={(event) => setSid(event.target.value)}
                  className="font-mono"
                  dir="ltr"
                />
              )}
            </FormField>
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.8125rem] font-medium">{t('policies.statement.effect')}</span>
              <SegmentedControl
                options={effectOptions}
                value={effect}
                onValueChange={setEffect}
                className="w-full [&>*]:flex-1"
                aria-label={t('policies.statement.effect')}
              />
            </div>
          </div>

          <ValueList
            label={t('policies.statement.actions')}
            hint={t('policies.statement.actionsHint')}
            values={actions}
            onValuesChange={setActions}
            options={actionOptions}
            placeholder="s3:GetObject"
          />

          <ValueList
            label={t('policies.statement.resources')}
            hint={t('policies.statement.resourcesHint')}
            values={resources}
            onValuesChange={setResources}
            options={resourceOptions}
            placeholder="arn:aws:s3:::bucket/*"
          />

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-medium">
              {t('policies.statement.conditions')}
            </span>
            <SectionCard flush>
              {conditions.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  {t('policies.statement.noConditions')}
                </p>
              ) : (
                conditions.map((row, rowIndex) => (
                  <div
                    key={`${row.operator}-${row.key}-${String(rowIndex)}`}
                    className="flex flex-wrap items-end gap-2 border-b p-3 last:border-b-0"
                  >
                    <Combobox
                      options={conditionOperatorOptions}
                      value={row.operator}
                      onValueChange={(operator) =>
                        setConditions(
                          conditions.map((entry, i) =>
                            i === rowIndex
                              ? { ...entry, operator: operator ?? 'StringEquals' }
                              : entry,
                          ),
                        )
                      }
                      className="w-40"
                      aria-label={t('policies.statement.conditionOperator')}
                    />
                    <Input
                      value={row.key}
                      onChange={(event) =>
                        setConditions(
                          conditions.map((entry, i) =>
                            i === rowIndex ? { ...entry, key: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="aws:SourceIp"
                      className="min-w-0 flex-1 font-mono"
                      dir="ltr"
                      aria-label={t('policies.statement.conditionKey')}
                    />
                    <Input
                      value={row.value}
                      onChange={(event) =>
                        setConditions(
                          conditions.map((entry, i) =>
                            i === rowIndex ? { ...entry, value: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="10.0.0.0/8"
                      className="min-w-0 flex-1 font-mono"
                      dir="ltr"
                      aria-label={t('policies.statement.conditionValue')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        setConditions(conditions.filter((_entry, i) => i !== rowIndex))
                      }
                      aria-label={t('policies.statement.removeCondition')}
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))
              )}
            </SectionCard>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setConditions([
                  ...conditions,
                  { operator: 'StringEquals', key: '', value: '' },
                ])
              }
            >
              <PlusIcon />
              {t('policies.statement.addCondition')}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon('action.cancel')}
          </Button>
          <Button type="button" onClick={save} disabled={!canSave}>
            {tCommon('action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A list of ARNs or action names: pick from the suggestions or type a new one.
 * Both matter — the suggestions cover the ninety per cent, and the free text is
 * what makes a provider-specific namespace possible at all.
 */
function ValueList({
  label,
  hint,
  values,
  onValuesChange,
  options,
  placeholder,
}: {
  readonly label: string;
  readonly hint: string;
  readonly values: readonly string[];
  readonly onValuesChange: (next: readonly string[]) => void;
  readonly options: readonly ComboboxOption<string>[];
  readonly placeholder: string;
}) {
  const { t } = useTranslation('pages');
  const [draft, setDraft] = useState('');

  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || values.includes(trimmed)) return;
    onValuesChange([...values, trimmed]);
    setDraft('');
  };

  return (
    <FormField label={label} hint={hint}>
      {({ id }) => (
        <div className="flex flex-col gap-2">
          {values.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5">
              {values.map((value) => (
                <Badge key={value} variant="secondary" className="gap-1 font-mono">
                  <span dir="ltr">{value}</span>
                  <button
                    type="button"
                    onClick={() => onValuesChange(values.filter((entry) => entry !== value))}
                    aria-label={t('policies.statement.removeValue', { value })}
                    className="rounded-full hover:text-destructive"
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={id}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add(draft);
              }}
              placeholder={placeholder}
              className="min-w-0 flex-1 font-mono"
              dir="ltr"
            />
            <Button type="button" variant="outline" onClick={() => add(draft)}>
              <PlusIcon />
              {t('policies.statement.add')}
            </Button>
            <Combobox
              options={options}
              value={null}
              onValueChange={(value) => {
                if (value !== null) add(value);
              }}
              placeholder={t('policies.statement.suggestions')}
              className="w-full sm:w-52"
              aria-label={t('policies.statement.suggestions')}
            />
          </div>
        </div>
      )}
    </FormField>
  );
}
