/**
 * Pure helpers for the synced `asset` table (D9): encoding bytes for storage,
 * sizing, and finding the assets a markdown document references.
 *
 * No IndexedDB, no DOM — shared by AssetApp and unit-tested in node. The
 * editor-facing store (save/load/resolve) lives in lib/assets.ts (Phase 7).
 */

/** Per-asset cap (D9). Checked against the raw bytes, before base64. */
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;

/**
 * `assets/<uuid>.<ext>` — the extension may be compound, as in drawings'
 * `assets/<uuid>.excalidraw.png`. The look-behind stops `myassets/…` from
 * matching while still allowing `./assets/…`, `(assets/…` and `/assets/…`.
 */
const ASSET_REF =
  /(?<![\w-])assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)+/gi;

/**
 * The asset ids (lower-cased uuids) referenced from a markdown string, unique,
 * in order of first appearance. `null`/empty input references nothing.
 */
export function assetRefsIn(markdown: string | null | undefined): string[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(ASSET_REF)) {
    seen.add(match[1]!.toLowerCase());
  }
  return [...seen];
}

/** Base64 of raw bytes. Chunked so a 5 MB file does not blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Raw bytes of a base64 string (inverse of bytesToBase64). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Size(base64: string): number {
  const clean = base64.replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** "0 B", "512 B", "1.5 KB", "12 MB" — binary units, one decimal below 10. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} B`;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}
