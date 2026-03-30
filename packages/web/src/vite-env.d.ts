/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DB_CONFIG: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
