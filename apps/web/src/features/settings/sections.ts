import {
  ArrowUpDownIcon,
  BellIcon,
  HardDriveDownloadIcon,
  InfoIcon,
  LanguagesIcon,
  PaletteIcon,
  ShieldIcon,
  UserRoundIcon,
  WebhookIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The sections of the Settings page, in order.
 *
 * One list drives the nav, the scroll spy and the anchors, so a section cannot
 * exist without a nav entry or be linked to by an id nothing renders. Other pages
 * deep-link here by these ids (`/settings#activity-forwarding` from the activity
 * log, `#transfers` from the jobs menu), which is why they are a typed union
 * rather than free strings.
 */

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly icon: LucideIcon;
  /** Draws the nav's divider above this entry, as the concept does before About. */
  readonly separatorBefore?: boolean;
}

export const SETTINGS_SECTION_IDS = [
  'account',
  'security',
  'appearance',
  'region',
  'transfers',
  'notifications',
  'activity-forwarding',
  'backup-retention',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'account', icon: UserRoundIcon },
  { id: 'security', icon: ShieldIcon },
  { id: 'appearance', icon: PaletteIcon },
  { id: 'region', icon: LanguagesIcon },
  { id: 'transfers', icon: ArrowUpDownIcon },
  { id: 'notifications', icon: BellIcon },
  { id: 'activity-forwarding', icon: WebhookIcon },
  { id: 'backup-retention', icon: HardDriveDownloadIcon },
  { id: 'about', icon: InfoIcon, separatorBefore: true },
];
