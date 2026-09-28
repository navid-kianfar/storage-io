import type { ActivityCategory, ActivityResult } from '@storage-io/contracts';
import {
  BanIcon,
  DatabaseIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayersIcon,
  LogInIcon,
  PlugZapIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UploadIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The icon and tone each event is drawn with.
 *
 * The *action* decides the icon where it can (an upload looks like an upload), and
 * the category is the fallback, because the action namespace is open-ended and a
 * new verb must still render. The tone comes from the result, never from the verb:
 * a delete that succeeded is not a failure.
 */

export const ACTIVITY_RESULT_BADGES: Readonly<
  Record<ActivityResult, 'success' | 'warning' | 'danger'>
> = {
  success: 'success',
  warning: 'warning',
  failure: 'danger',
};

export const ACTIVITY_RESULT_TONES: Readonly<Record<ActivityResult, string>> = {
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  failure: 'bg-destructive/12 text-destructive',
};

const CATEGORY_ICONS: Readonly<Record<ActivityCategory, LucideIcon>> = {
  objects: UploadIcon,
  buckets: DatabaseIcon,
  access: KeyRoundIcon,
  servers: PlugZapIcon,
  jobs: LayersIcon,
  system: SettingsIcon,
  auth: LogInIcon,
};

/** Verb prefixes worth their own icon; everything else falls back to the category. */
const ACTION_ICONS: readonly (readonly [string, LucideIcon])[] = [
  ['object.upload', UploadIcon],
  ['object.delete', Trash2Icon],
  ['bucket.delete', Trash2Icon],
  ['quota', GaugeIcon],
  ['policy', ShieldCheckIcon],
  ['key', KeyRoundIcon],
  ['access.denied', BanIcon],
  ['job', LayersIcon],
];

export function activityIcon(action: string, category: ActivityCategory): LucideIcon {
  const lowered = action.toLowerCase();
  for (const [prefix, icon] of ACTION_ICONS) {
    if (lowered.startsWith(prefix)) return icon;
  }
  return CATEGORY_ICONS[category];
}

/** The `from`/`to` shortcuts the date filter offers, in hours. */
export const ACTIVITY_RANGES = ['1h', '24h', '7d', '30d', 'custom'] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

const HOUR_MS = 3_600_000;
const RANGE_MS: Readonly<Record<Exclude<ActivityRange, 'custom'>, number>> = {
  '1h': HOUR_MS,
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

/** The ISO `from` a preset means, or null for a custom range. */
export function rangeFrom(range: ActivityRange): string | null {
  if (range === 'custom') return null;
  return new Date(Date.now() - RANGE_MS[range]).toISOString();
}

/** A calendar day's bounds, so a custom range includes both end days in full. */
export function dayBounds(start: Date, end: Date): { readonly from: string; readonly to: string } {
  const from = new Date(start);
  from.setHours(0, 0, 0, 0);
  const to = new Date(end);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** `2026-09-28` — the key the table groups rows by. */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}
