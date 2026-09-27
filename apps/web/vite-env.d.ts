/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base path of the API, proxied to the NestJS app in dev. */
  readonly VITE_API_BASE_URL?: string;
  /** `'1'` turns the MSW browser mocks on, so the UI renders without an API. */
  readonly VITE_MOCK_API?: '0' | '1';
  /** Version string shown in the sidebar and the login footer. */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
