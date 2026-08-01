/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the brewsync API. Empty string in dev = same-origin via proxy. */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
