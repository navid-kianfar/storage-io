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
 * The sections of Settings, in order. Each one is a route —
 * `/settings/$section` — and this list is the whole of what `$section` may be
 * (docs/ROUTES.md). One list drives the nav and the routing, so a section cannot
 * exist without a nav entry or be linked to by an id nothing renders; other pages
 * deep-link here by these ids (`/settings/forwarding` from the activity log,
 * `/settings/transfers` from the jobs menu), which is why they are a typed union
 * rather than free strings.
 */

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly icon: LucideIcon;
  /** Draws the nav's divider above this entry, as the concept does before About. */
  readonly separatorBefore?: boolean;
}

/** Whether a `$section` route param names a real section. */
export function isSettingsSection(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export const SETTINGS_SECTION_IDS = [
  'account',
  'security',
  'appearance',
  'region',
  'transfers',
  'notifications',
  'forwarding',
  'backup',
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
  { id: 'forwarding', icon: WebhookIcon },
  { id: 'backup', icon: HardDriveDownloadIcon },
  { id: 'about', icon: InfoIcon, separatorBefore: true },
];
