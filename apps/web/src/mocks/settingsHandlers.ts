import { API_PREFIX, SETTINGS_DEFAULTS, type Settings, type UpdateSettingsRequest } from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';

/**
 * `GET` and `PATCH /settings`, stateful, so the transfers page's settings card can
 * actually be saved and read back in `pnpm dev:mock`.
 *
 * `PATCH` merges one level deep per section, which is what
 * `updateSettingsRequestSchema` describes — a client may send
 * `{ transfers: { parallel: 8 } }` without resending the rest.
 */

const base = API_PREFIX;

let settings: Settings = structuredClone(SETTINGS_DEFAULTS);

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
    };
    return HttpResponse.json(settings);
  }),
];
