import { CopyIcon, HouseIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/app/Button';
import { prefixSegments } from '../api';

/**
 * The prefix breadcrumb. Every segment is a button that navigates to that prefix,
 * and the whole path can be copied as an `s3://` URI — the form an operator pastes
 * into `mc`, `aws s3` or rclone.
 *
 * The path is always rendered left-to-right: an object key is an identifier, and
 * mirroring it in Persian or Arabic would change what it means.
 */
export function PathBar({
  bucket,
  prefix,
  onNavigate,
}: {
  readonly bucket: string;
  readonly prefix: string;
  readonly onNavigate: (prefix: string) => void;
}) {
  const { t } = useTranslation('pages');
  const { t: tCommon } = useTranslation();
  const segments = prefixSegments(prefix);
  const uri = `s3://${bucket}/${prefix}`;

  function copy(): void {
    void navigator.clipboard.writeText(uri).then(
      () => toast.success(tCommon('action.copied'), { description: uri }),
      () => toast.error(tCommon('action.copy'), { description: uri }),
    );
  }

  return (
    <nav
      aria-label={t('browse.path.label')}
      className="ltr-isolate flex min-w-0 items-center gap-0.5 overflow-x-auto"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('browse.path.root')}
        aria-current={prefix === '' ? 'true' : undefined}
        onClick={() => onNavigate('')}
      >
        <HouseIcon />
      </Button>

      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span key={segment.prefix} className="flex shrink-0 items-center gap-0.5">
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            {isLast ? (
              <span className="px-2 font-mono text-sm font-medium" aria-current="true">
                {segment.name}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="font-mono"
                onClick={() => onNavigate(segment.prefix)}
              >
                {segment.name}
              </Button>
            )}
          </span>
        );
      })}

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('browse.path.copyUri')}
        onClick={copy}
        className="ms-1 shrink-0"
      >
        <CopyIcon />
      </Button>
    </nav>
  );
}
