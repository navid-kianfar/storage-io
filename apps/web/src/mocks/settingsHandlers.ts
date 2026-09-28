import {
  API_PREFIX,
  NOTIFICATION_CHANNELS,
  SETTINGS_DEFAULTS,
  type NotificationChannel,
  type NotificationRules,
  type Settings,
  type UpdateSettingsRequest,
} from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';

/**
 * `GET`, `PATCH` and the per-channel `DELETE` on `/settings`, stateful, so the
 * transfers card and the notification channels can actually be saved and read
 * back in `pnpm dev:mock`.
 *
 * `PATCH` merges one level deep per section, which is what
 * `updateSettingsRequestSchema` describes — a client may send
 * `{ transfers: { parallel: 8 } }` without resending the rest.
 */

const base = API_PREFIX;

let settings: Settings = structuredClone(SETTINGS_DEFAULTS);

const isChannel = (value: string): value is NotificationChannel =>
  (NOTIFICATION_CHANNELS as readonly string[]).includes(value);

export const settingsHandlers = [
  http.get(`${base}/settings`, () => HttpResponse.json(settings)),

  http.patch(`${base}/settings`, async ({ request }) => {
    const body = (await request.json()) as UpdateSettingsRequest;
    settings = {
      ...settings,
      profile: { ...settings.profile, ...body.profile },
      security: { ...settings.security, ...body.security },
      appearance: { ...settings.appearance, ...body.appearance },
      region: { ...settings.region, ...body.region },
      transfers: { ...settings.transfers, ...body.transfers },
      retention: { ...settings.retention, ...body.retention },
      health: { ...settings.health, ...body.health },
      notifications: {
        ...settings.notifications,
        email: { ...settings.notifications.email, ...body.notifications?.email },
        webhook: { ...settings.notifications.webhook, ...body.notifications?.webhook },
        telegram: { ...settings.notifications.telegram, ...body.notifications?.telegram },
        rules: { ...settings.notifications.rules, ...body.notifications?.rules },
      },
    };
    return HttpResponse.json(settings);
  }),

  http.delete(`${base}/settings/notifications/:channel`, ({ params }) => {
    const channel = String(params['channel']);
    if (!isChannel(channel)) return HttpResponse.json({ code: 'VALIDATION' }, { status: 400 });

    const clearedEntries = Object.entries(settings.notifications.rules).map(([key, rule]) => [
      key,
      { ...rule, [channel]: false },
    ]);
    const rules = Object.fromEntries(clearedEntries) as NotificationRules;

    settings = {
      ...settings,
      notifications: {
        ...settings.notifications,
        [channel]: structuredClone(SETTINGS_DEFAULTS.notifications[channel]),
        rules,
      },
    };
    return HttpResponse.json(settings);
  }),
];
