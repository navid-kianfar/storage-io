import {
  CAPABILITIES,
  type Capability,
  type CapabilityState,
  type Server,
} from '@storage-io/contracts';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ActivityIcon,
  ArchiveIcon,
  BanIcon,
  CheckIcon,
  DatabaseIcon,
  GaugeIcon,
  GitBranchIcon,
  InfoIcon,
  KeyRoundIcon,
  LockIcon,
  RefreshCwIcon,
  RepeatIcon,
  ServerIcon,
  ShieldCheckIcon,
  TagIcon,
  TimerIcon,
  TriangleAlertIcon,
  UsersIcon,
  WebhookIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  DataTable,
  SectionCard,
  Spinner,
} from '@/components/app';

/**
 * The capability matrix. It is the honest version of the concept's table: every
 * row's state comes from the server's own `capabilities` map, which the API fills
 * by probing, so a capability that appears after a server upgrade appears here
 * without anyone editing a list.
 *
 * The note column explains *why* a capability is in the state it is in, which is
 * the difference between "not supported" (this provider cannot) and "not
 * configured" (this deployment has not).
 */

const CAPABILITY_ICONS: Readonly<Record<Capability, typeof DatabaseIcon>> = {
  objects: DatabaseIcon,
  versioning: GitBranchIcon,
  objectLock: LockIcon,
  lifecycle: TimerIcon,
  cors: WebhookIcon,
  bucketPolicy: ShieldCheckIcon,
  tagging: TagIcon,
  replication: RepeatIcon,
  notifications: WebhookIcon,
  encryption: ShieldCheckIcon,
  storageClasses: ArchiveIcon,
  iamUsers: UsersIcon,
  iamGroups: UsersIcon,
  iamPolicies: ShieldCheckIcon,
  accessKeys: KeyRoundIcon,
  accessKeyExpiry: TimerIcon,
  bucketQuota: GaugeIcon,
  usageStats: GaugeIcon,
  nodes: ServerIcon,
  traffic: ActivityIcon,
};

const STATE_BADGES: Readonly<
  Record<CapabilityState, { readonly variant: 'success' | 'warning' | 'secondary'; readonly icon: typeof CheckIcon }>
> = {
  supported: { variant: 'success', icon: CheckIcon },
  not_configured: { variant: 'warning', icon: TriangleAlertIcon },
  not_supported: { variant: 'secondary', icon: BanIcon },
};

interface CapabilityRow {
  readonly name: Capability;
  readonly state: CapabilityState;
}

export function ServerCapabilitiesTab({
  server,
  onRedetect,
  redetecting,
}: {
  readonly server: Server;
  readonly onRedetect: () => void;
  readonly redetecting: boolean;
}) {
  const { t } = useTranslation('pages');
  const { t: tDomain } = useTranslation('domain');

  const rows = useMemo<readonly CapabilityRow[]>(
    () => CAPABILITIES.map((name) => ({ name, state: server.capabilities[name] })),
    [server.capabilities],
  );

  const columns = useMemo<readonly ColumnDef<CapabilityRow, unknown>[]>(
    () => [
      {
        id: 'feature',
        size: 260,
        header: () => t('server.capabilities.feature'),
        cell: ({ row }) => {
          const Icon = CAPABILITY_ICONS[row.original.name];
          return (
            <div className="flex items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-[0.8125rem] font-medium">
                {tDomain(`capability.${row.original.name}`)}
              </span>
            </div>
          );
        },
      },
      {
        id: 'state',
        size: 170,
        header: () => t('server.capabilities.status'),
        cell: ({ row }) => {
          const badge = STATE_BADGES[row.original.state];
          const Icon = badge.icon;
          return (
            <Badge variant={badge.variant}>
              <Icon />
              {tDomain(`capabilityState.${row.original.state}`)}
            </Badge>
          );
        },
      },
      {
        id: 'note',
        header: () => t('server.capabilities.note'),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {t(`server.capabilities.note_${row.original.state}`, {
              provider: tDomain(`provider.${server.provider}`),
            })}
          </span>
        ),
      },
    ],
    [server.provider, t, tDomain],
  );

  return (
    <div className="flex flex-col gap-(--gap)">
      <SectionCard
        title={t('server.capabilities.title')}
        description={t('server.capabilities.description')}
        action={
          <Button variant="outline" size="sm" onClick={onRedetect} disabled={redetecting}>
            {redetecting ? <Spinner /> : <RefreshCwIcon />}
            {t('server.capabilities.redetect')}
          </Button>
        }
        flush
      >
        <DataTable
          aria-label={t('server.capabilities.title')}
          columns={columns}
          data={rows}
          getRowId={(row) => row.name}
        />
      </SectionCard>

      <Alert variant="info">
        <InfoIcon />
        <AlertTitle>{t('server.capabilities.noteTitle')}</AlertTitle>
        <AlertDescription>{t('server.capabilities.noteBody')}</AlertDescription>
      </Alert>
    </div>
  );
}
