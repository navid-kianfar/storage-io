import { CheckIcon, CopyIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const CONFIRM_MS = 1600;

/**
 * A value the operator will copy: an endpoint, an access key ID, an S3 URI, a
 * shell command. Always LTR and monospaced even in an RTL page, because the value
 * is not prose.
 */
export function CopyField({
  value,
  label,
  multiline = false,
  className,
}: {
  readonly value: string;
  /** Accessible name for the copy button, e.g. "Copy access key ID". */
  readonly label?: string;
  /** For a longer value (a JSON snippet, a CLI block) that should wrap. */
  readonly multiline?: boolean;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const copy = useCallback(() => {
    const write = async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setCopied(false), CONFIRM_MS);
      } catch {
        // Clipboard access is refused without a user gesture or over plain HTTP.
        // Say so rather than silently doing nothing.
        toast.error(t('action.copy'), { description: t('error.unexpected') });
      }
    };
    void write();
  }, [value, t]);

  const buttonLabel = label ?? t('action.copy');

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border bg-muted py-1.5 ps-3 pe-1.5 font-mono text-xs',
        multiline && 'items-start',
        className,
      )}
    >
      <span className={cn('ltr-isolate min-w-0 flex-1', multiline ? 'break-all' : 'truncate')}>
        {value}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={copy} aria-label={buttonLabel}>
            {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? t('action.copied') : buttonLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}
