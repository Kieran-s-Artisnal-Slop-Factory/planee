/// <reference types="astro/client" />

interface ImportMetaEnv {
  /**
   * Build-time default sync mode, used until the user picks one in Settings.
   * 'offline' for static hosts with no sync backend (the GitHub Pages build,
   * see .github/workflows/pages.yaml); unset or anything else means 'sync'.
   */
  readonly PUBLIC_DEFAULT_SYNC_MODE?: string;
}
