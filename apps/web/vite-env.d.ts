/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base path of the API, proxied to the NestJS app in dev. */
  readonly VITE_API_BASE_URL?: string;
  /** `'1'` turns the MSW browser mocks on, so the UI renders without an API. */
  readonly VITE_MOCK_API?: '0' | '1';
  /** Version string shown in the sidebar and the login footer. */
  readonly VITE_APP_VERSION?: string;
  /**
   * Where Settings → About checks for a newer release. storage-io runs
   * on-premise and may be offline, so there is no default: with this unset the
   * "Check for updates" button is not rendered at all.
   */
  readonly VITE_UPDATE_CHECK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
