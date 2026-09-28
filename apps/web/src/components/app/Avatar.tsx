import {
  Avatar as AvatarRoot,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/**
 * The avatar. storage-io has no user photos: every avatar is initials on one of
 * the concept's five tinted squares (`.avatar.sq.c1`…`.c5`), and the tint is
 * derived from the name so the same S3 user always looks the same.
 */
export { AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage, AvatarRoot };

const TINTS = [
  'bg-chart-1/15 text-chart-1',
  'bg-chart-2/20 text-chart-2',
  'bg-chart-3/18 text-chart-3',
  'bg-chart-4/22 text-chart-4',
  'bg-chart-5/18 text-chart-5',
] as const;

const INITIALS_LENGTH = 2;

function tintFor(name: string): string {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) % 4093;
  return TINTS[hash % TINTS.length]!;
}

function initialsOf(name: string): string {
  const words = name.split(/[^a-z0-9]+/i).filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, INITIALS_LENGTH).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

export function InitialsAvatar({
  name,
  size = 'sm',
  className,
}: {
  readonly name: string;
  readonly size?: 'sm' | 'default' | 'lg';
  readonly className?: string;
}) {
  return (
    <AvatarRoot size={size} className={cn('rounded-md', className)} aria-hidden="true">
      <AvatarFallback
        className={cn('rounded-md font-mono text-[0.625rem] font-bold', tintFor(name))}
      >
        {initialsOf(name)}
      </AvatarFallback>
    </AvatarRoot>
  );
}
