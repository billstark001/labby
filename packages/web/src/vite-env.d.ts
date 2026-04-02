/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DB_CONFIG: string;
  readonly VITE_DEPLOYMENT_MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
