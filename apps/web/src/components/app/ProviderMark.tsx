import { PROVIDER_LABELS, type Provider } from '@storage-io/contracts';
import { cn } from '@/lib/utils';

/**
 * The two-letter provider tile: MI, SW, S3, CE, GA, R2, WA. Colours are the
 * concept's `--provider-*` tokens (global.css section 6), never literals.
 */

const PROVIDER_MARKS: Readonly<Record<Provider, string>> = {
  minio: 'MI',
  seaweedfs: 'SW',
  aws: 'S3',
  ceph: 'CE',
  garage: 'GA',
  r2: 'R2',
  wasabi: 'WA',
  generic: 'S3',
};

const PROVIDER_BACKGROUNDS: Readonly<Record<Provider, string>> = {
  minio: 'bg-provider-minio',
  seaweedfs: 'bg-provider-seaweedfs',
  aws: 'bg-provider-aws',
  ceph: 'bg-provider-ceph',
  garage: 'bg-provider-garage',
  r2: 'bg-provider-r2',
  wasabi: 'bg-provider-wasabi',
  generic: 'bg-provider-generic',
};

const SIZE_CLASSES = {
  sm: 'size-6 text-[0.625rem] rounded-sm',
  md: 'size-7 text-[0.6875rem] rounded-md',
  lg: 'size-10 text-sm rounded-md',
} as const;

export type ProviderMarkSize = keyof typeof SIZE_CLASSES;

export function providerMark(provider: Provider): string {
  return PROVIDER_MARKS[provider];
}

export function ProviderMark({
  provider,
  size = 'md',
  className,
}: {
  readonly provider: Provider;
  readonly size?: ProviderMarkSize;
  readonly className?: string;
}) {
  return (
    <span
      // The label is for assistive tech; the two letters are decoration.
      role="img"
      aria-label={PROVIDER_LABELS[provider]}
      className={cn(
        'grid shrink-0 place-items-center font-mono font-bold tracking-[-0.02em] text-white',
        PROVIDER_BACKGROUNDS[provider],
        SIZE_CLASSES[size],
        className,
      )}
    >
      {PROVIDER_MARKS[provider]}
    </span>
  );
}
