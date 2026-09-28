import type { Job, JobType } from '@storage-io/contracts';
import {
  ArchiveIcon,
  CopyIcon,
  EraserIcon,
  FolderInputIcon,
  LockIcon,
  RotateCcwIcon,
  TagsIcon,
  Trash2Icon,
  type LucideIcon,
} from 'lucide-react';

/**
 * One icon per operation, matching the concept's job cards and history rows, and
 * the two questions every screen asks about a job type: does it write to a target
 * (so the wizard needs a target step), and is it destructive (so a dry run is on by
 * default and the confirmation is harder).
 */

export const JOB_TYPE_ICONS: Readonly<Record<JobType, LucideIcon>> = {
  copy: CopyIcon,
  move: FolderInputIcon,
  delete: Trash2Icon,
  tag: TagsIcon,
  'storage-class': ArchiveIcon,
  retention: LockIcon,
  'restore-versions': RotateCcwIcon,
  'empty-bucket': EraserIcon,
};

/** Only copy and move write somewhere else; the rest act on the source in place. */
export const JOB_TYPES_WITH_TARGET: readonly JobType[] = ['copy', 'move'];

/** Cannot be undone once an object is touched, so the wizard defaults to a dry run. */
export const DESTRUCTIVE_JOB_TYPES: readonly JobType[] = [
  'delete',
  'move',
  'retention',
  'empty-bucket',
];

/** The seven operations the wizard offers; `empty-bucket` is started from a bucket. */
export const WIZARD_JOB_TYPES: readonly JobType[] = [
  'copy',
  'move',
  'delete',
  'tag',
  'storage-class',
  'retention',
  'restore-versions',
];

export function jobHasTarget(type: JobType): boolean {
  return JOB_TYPES_WITH_TARGET.includes(type);
}

export function jobIsDestructive(type: JobType): boolean {
  return DESTRUCTIVE_JOB_TYPES.includes(type);
}

/** `media-prod/raw/` — the source line under a job's name. */
export function jobSourcePath(job: Job): string {
  const prefix = job.source.filters.prefix;
  return prefix.length > 0 ? `${job.source.bucket}/${prefix}` : job.source.bucket;
}

/** `seaweed-archive/media-cold/` — null when the operation has no target. */
export function jobTargetPath(job: Job): string | null {
  if (job.target === null) return null;
  const prefix = job.target.prefix;
  return prefix.length > 0 ? `${job.target.bucket}/${prefix}` : job.target.bucket;
}

/** True while the job can still be paused, resumed or cancelled. */
export function jobIsLive(job: Job): boolean {
  return job.status === 'running' || job.status === 'paused' || job.status === 'queued';
}
