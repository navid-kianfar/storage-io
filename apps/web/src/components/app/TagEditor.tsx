import { PlusIcon, XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The key/value chip editor: bucket tags, object tags, a lifecycle rule's tag
 * filter. One component, because "10 tags, no duplicate keys, a chip each with a
 * remove button" is the same rule everywhere and a second copy of it drifts.
 *
 * Controlled: the parent owns the record and decides when it is saved. Tags are
 * always shown left-to-right — a key is an identifier, not prose.
 */

export const TAG_LIMIT_DEFAULT = 10;

export function TagEditor({
  tags,
  onTagsChange,
  limit = TAG_LIMIT_DEFAULT,
  disabled = false,
  hint,
  className,
}: {
  readonly tags: Readonly<Record<string, string>>;
  readonly onTagsChange: (tags: Readonly<Record<string, string>>) => void;
  readonly limit?: number;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly className?: string;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const keyId = useId();
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');

  const entries = Object.entries(tags);
  const trimmedKey = draftKey.trim();
  const isDuplicate = trimmedKey.length > 0 && Object.hasOwn(tags, trimmedKey);
  const isFull = entries.length >= limit;
  const canAdd = trimmedKey.length > 0 && !isDuplicate && !isFull && !disabled;

  function add(): void {
    if (!canAdd) return;
    onTagsChange({ ...tags, [trimmedKey]: draftValue.trim() });
    setDraftKey('');
    setDraftValue('');
  }

  function remove(key: string): void {
    const next: Record<string, string> = {};
    for (const [existingKey, existingValue] of entries) {
      if (existingKey === key) continue;
      next[existingKey] = existingValue;
    }
    onTagsChange(next);
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {entries.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {entries.map(([key, value]) => (
            <li
              key={key}
              className="ltr-isolate inline-flex items-center gap-1 rounded-sm border bg-muted/60 py-0.5 pe-0.5 ps-2 font-mono text-xs"
            >
              <span>
                <b className="font-semibold">{key}</b>
                {value.length > 0 ? `=${value}` : null}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                onClick={() => remove(key)}
                aria-label={`${t('bucket.general.removeTag')} ${key}`}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-start gap-2">
        <Input
          id={keyId}
          value={draftKey}
          onChange={(event) => setDraftKey(event.target.value)}
          placeholder={t('bucket.general.tagKey')}
          disabled={disabled || isFull}
          aria-invalid={isDuplicate}
          aria-label={t('bucket.general.tagKey')}
          className="ltr-isolate w-40 font-mono"
        />
        <Input
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
          placeholder={t('bucket.general.tagValue')}
          disabled={disabled || isFull}
          aria-label={t('bucket.general.tagValue')}
          className="ltr-isolate w-40 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={add}
          disabled={!canAdd}
          aria-label={t('bucket.general.addTag')}
        >
          <PlusIcon />
        </Button>
      </div>

      {isDuplicate ? (
        <p className="text-[0.8125rem] text-destructive">{t('bucket.general.duplicateTag')}</p>
      ) : (
        <p className="text-[0.8125rem] text-muted-foreground">
          {hint ?? t('bucket.general.tagsLimit', { count: limit })}
        </p>
      )}
      {entries.length === 0 && disabled ? (
        <span className="sr-only">{tCommon('state.empty')}</span>
      ) : null}
    </div>
  );
}
