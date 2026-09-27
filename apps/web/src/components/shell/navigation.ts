import {
  ArrowUpDownIcon,
  DatabaseIcon,
  FolderOpenIcon,
  GaugeIcon,
  HistoryIcon,
  KeyRoundIcon,
  LayersIcon,
  LayoutDashboardIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The sidebar, in one place. The four groups and their order are the concept's
 * (General / Storage / Access / System).
 *
 * `count` names which live number the item shows next to it — the shell resolves
 * it from the dashboard query, so the nav does not fetch anything itself.
 * `live` marks a count that means "in flight" and is therefore tinted.
 */
export type NavCount = 'servers' | 'buckets' | 'users' | 'keys' | 'activeJobs';

export interface NavItem {
  readonly to: string;
  /** Key in the `nav` namespace, `item.<key>`. */
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly count?: NavCount;
  readonly live?: boolean;
  /** The two-key sequence the command palette advertises, e.g. "G S". */
  readonly shortcut?: string;
}

export interface NavGroup {
  /** Key in the `nav` namespace, `group.<key>`. */
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    labelKey: 'general',
    items: [
      { to: '/', labelKey: 'overview', icon: LayoutDashboardIcon, shortcut: 'G O' },
      { to: '/servers', labelKey: 'servers', icon: ServerIcon, count: 'servers', shortcut: 'G S' },
    ],
  },
  {
    labelKey: 'storage',
    items: [
      {
        to: '/buckets',
        labelKey: 'buckets',
        icon: DatabaseIcon,
        count: 'buckets',
        shortcut: 'G B',
      },
      { to: '/browse', labelKey: 'browse', icon: FolderOpenIcon, shortcut: 'G F' },
      { to: '/quotas', labelKey: 'quotas', icon: GaugeIcon, shortcut: 'G Q' },
      {
        to: '/jobs',
        labelKey: 'jobs',
        icon: LayersIcon,
        count: 'activeJobs',
        live: true,
        shortcut: 'G J',
      },
      { to: '/transfers', labelKey: 'transfers', icon: ArrowUpDownIcon, shortcut: 'G T' },
    ],
  },
  {
    labelKey: 'access',
    items: [
      { to: '/users', labelKey: 'users', icon: UsersIcon, count: 'users', shortcut: 'G U' },
      { to: '/policies', labelKey: 'policies', icon: ShieldCheckIcon, shortcut: 'G P' },
      { to: '/keys', labelKey: 'keys', icon: KeyRoundIcon, count: 'keys', shortcut: 'G K' },
    ],
  },
  {
    labelKey: 'system',
    items: [
      { to: '/activity', labelKey: 'activity', icon: HistoryIcon, shortcut: 'G A' },
      { to: '/settings', labelKey: 'settings', icon: SettingsIcon, shortcut: 'G ,' },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
