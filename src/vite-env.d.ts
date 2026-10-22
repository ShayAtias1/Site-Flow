/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** '1' only in builds made by the acceptance tests: enables fault injection. */
  readonly VITE_TEST_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build time of this app version (vite.config.ts), shown in the System screen. */
declare const __APP_BUILD__: string;
