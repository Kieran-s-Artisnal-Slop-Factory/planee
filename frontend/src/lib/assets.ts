/**
 * Where the markdown editor puts the bytes for pasted images and drawings.
 *
 * Ported from retoken (af25bc6) src/lib/assets.ts. The `AssetStore` interface
 * and `memoryAssets()` are unchanged, except for one optional addition,
 * `preload`, which the editor awaits before mounting so a synchronous
 * `resolve` can answer for every image already in the document.
 *
 * planee adds `dbAssets()` (D9): the bytes live in the synced `asset` table
 * (base64 TEXT, 5 MB per asset) and markdown references them as
 * `assets/<uuid>.<ext>` — drawings as `assets/<uuid>.excalidraw.png`. Writes go
 * through repo.ts (`put` for a new row, `patch` for replaced bytes), so they
 * are stamped, queued and synced like any other edit.
 *
 * The editor never talks to a database — it talks to an AssetStore. Markdown
 * keeps a plain relative ref which is exactly what you would save or export;
 * the store maps that ref to something the browser can display, and back to
 * bytes when a drawing is reopened for editing.
 */
import { ASSET_MAX_BYTES, assetRefsIn, base64ToBytes, bytesToBase64, humanSize } from './assetRefs';
import { get, patch, put, withSyncFields } from './db/repo';
import type { Asset, SyncFields } from './db/types';

export interface AssetStore {
  /**
   * Store `blob` under a name derived from `filename` and return the src to
   * write into the markdown. Implementations may rename to avoid collisions.
   */
  save(blob: Blob, filename: string): Promise<string>;
  /**
   * Replace the bytes behind an existing src, keeping the src itself valid —
   * this is what lets an edited drawing update every reference to it at
   * once. Optional: without it, editing a drawing inserts a new one.
   */
  replace?(src: string, blob: Blob): Promise<void>;
  /** The bytes behind a src, for reopening a drawing. */
  load?(src: string): Promise<Blob | null>;
  /**
   * A displayable URL for a stored src, or undefined to use the src as
   * written (already a URL the browser can fetch).
   */
  resolve?(src: string): string | undefined;
  /**
   * Make `resolve` able to answer for every image `markdown` references.
   * (planee addition; `resolve` must stay synchronous for Crepe.)
   */
  preload?(markdown: string): Promise<void>;
}

/* ── memoryAssets (unchanged from retoken) ────────────────────────────── */

/** The trailing `<folder>/<file>` of a ref, so `../images/a.png` matches `images/a.png`. */
function leafOf(src: string): string {
  return decodeURIComponent(src.split(/[?#]/)[0]!.split('/').pop() ?? '');
}

/** `thing (2).png` → a name that isn't taken yet. */
function uniqueName(taken: Set<string>, filename: string): string {
  const safe = (filename || 'image.png').replace(/[^\w.\- ]+/g, '-');
  if (!taken.has(safe)) return safe;
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The zero-config store: blobs live in a Map for the life of the page and
 * are handed out as object URLs. Nothing survives a reload.
 */
export function memoryAssets(prefix = 'images/'): AssetStore {
  const blobs = new Map<string, Blob>();
  const urls = new Map<string, string>();

  const urlFor = (name: string): string | undefined => {
    const blob = blobs.get(name);
    if (!blob) return undefined;
    let url = urls.get(name);
    if (!url) {
      url = URL.createObjectURL(blob);
      urls.set(name, url);
    }
    return url;
  };

  return {
    async save(blob, filename) {
      const name = uniqueName(new Set(blobs.keys()), filename);
      blobs.set(name, blob);
      return prefix + name;
    },
    async replace(src, blob) {
      const name = leafOf(src);
      if (!blobs.has(name)) return;
      blobs.set(name, blob);
      // Revoke the stale object URL so the next resolve() mints one over the
      // new bytes — the ref itself never moved.
      const url = urls.get(name);
      if (url) {
        URL.revokeObjectURL(url);
        urls.delete(name);
      }
    },
    async load(src) {
      const own = blobs.get(leafOf(src));
      if (own) return own;
      // Not ours — it may still be fetchable (data: / blob: / same-origin).
      try {
        const response = await fetch(src);
        return response.ok ? await response.blob() : null;
      } catch {
        return null;
      }
    },
    resolve(src) {
      return urlFor(leafOf(src));
    },
  };
}

/* ── Pure helpers for asset refs (unit-tested in node) ────────────────── */

/** The compound extension that marks a re-editable drawing (see excalidraw.ts). */
const DRAWING_EXT = 'excalidraw.png';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  [DRAWING_EXT]: 'image/png',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
};

/** A whole src that is an asset ref: `assets/<uuid>.<ext>`, optionally `./` or `/` first. */
const ASSET_SRC =
  /^(?:\.?\/)?assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)+$/i;

/** A single `assets/<uuid>.<ext>` src → its lower-cased uuid, or null. */
export function assetIdOf(src: string): string | null {
  const match = ASSET_SRC.exec(src.trim().split(/[?#]/)[0]!);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The extension to store a file under: drawings keep `excalidraw.png`, other
 * files their last extension (lower-cased, alphanumeric), and a file with no
 * usable extension gets one from its MIME type — `bin` as a last resort.
 */
export function assetExtension(filename: string, mime = ''): string {
  const name = filename.trim().toLowerCase();
  if (name.endsWith('.' + DRAWING_EXT)) return DRAWING_EXT;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (/^[a-z0-9]{1,10}$/.test(ext)) return ext;
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
}

/** The MIME type for a file: the blob's own when it has one, else by extension. */
export function assetMime(filename: string, blobType = ''): string {
  if (blobType) return blobType;
  return MIME_BY_EXT[assetExtension(filename)] ?? 'application/octet-stream';
}

/** The markdown src for a stored asset. */
export function assetSrc(id: string, ext: string): string {
  return `assets/${id}.${ext}`;
}

/** The user-facing refusal for a file over the per-asset cap (D9). */
export function assetTooLargeMessage(filename: string, size: number): string {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `“${filename || 'That file'}” is too large (${mb(size)}): images and drawings can be at most ${humanSize(ASSET_MAX_BYTES)}.`;
}

/* ── dbAssets: the synced asset table ────────────────────────────────── */

/**
 * id → a displayable object URL, plus the row version it was made from so a
 * drawing re-saved on another device (a newer `updated_at`) gets a fresh URL.
 * Module-level: every store, preview and editor on the page shares it.
 */
const cache = new Map<string, { url: string; updatedAt: string }>();

function cacheBlob(id: string, blob: Blob, updatedAt: string): string {
  const previous = cache.get(id);
  if (previous) URL.revokeObjectURL(previous.url);
  const url = URL.createObjectURL(blob);
  cache.set(id, { url, updatedAt });
  return url;
}

function forget(id: string): void {
  const previous = cache.get(id);
  if (!previous) return;
  URL.revokeObjectURL(previous.url);
  cache.delete(id);
}

function rowToBlob(row: Asset): Blob {
  return new Blob([base64ToBytes(row.data) as BlobPart], { type: row.mime });
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function assertSize(blob: Blob, filename: string): void {
  if (blob.size > ASSET_MAX_BYTES) throw new Error(assetTooLargeMessage(filename, blob.size));
}

/**
 * Load every asset `markdown` references into the object-URL cache, so the
 * synchronous resolver can answer. Rows already cached at the same version
 * are not decoded again; a deleted or missing row drops out of the cache (and
 * the preview shows its placeholder).
 */
export async function preloadAssets(markdown: string | null | undefined): Promise<void> {
  const ids = assetRefsIn(markdown);
  if (ids.length === 0) return;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const row = await get<Asset>('asset', id);
        if (!row || typeof row.data !== 'string') {
          forget(id);
          return;
        }
        if (cache.get(id)?.updatedAt === row.updated_at) return;
        cacheBlob(id, rowToBlob(row), row.updated_at);
      } catch {
        // Unreadable (IndexedDB unavailable, corrupt base64): leave it to the
        // placeholder rather than failing the whole render.
      }
    })
  );
}

/** The synchronous resolver: an object URL for a preloaded asset ref. */
export function resolveAsset(src: string): string | undefined {
  const id = assetIdOf(src);
  return id ? cache.get(id)?.url : undefined;
}

/**
 * The AssetStore over the synced `asset` table. Stateless apart from the
 * shared URL cache, so creating one per editor is free.
 */
export function dbAssets(): AssetStore {
  return {
    async save(blob, filename) {
      assertSize(blob, filename);
      const mime = assetMime(filename, blob.type);
      const ext = assetExtension(filename, mime);
      const row = withSyncFields<Omit<Asset, keyof SyncFields>>({
        name: filename || `image.${ext}`,
        mime,
        size: blob.size,
        data: await blobToBase64(blob),
      });
      const stored = await put<Asset>('asset', row);
      cacheBlob(stored.id, blob, stored.updated_at);
      return assetSrc(stored.id, ext);
    },

    async replace(src, blob) {
      const id = assetIdOf(src);
      if (!id) return;
      assertSize(blob, src);
      const current = await get<Asset>('asset', id);
      const mime = blob.type || current?.mime || assetMime(src);
      const next = await patch<Asset>('asset', id, {
        data: await blobToBase64(blob),
        size: blob.size,
        mime,
      });
      if (next) cacheBlob(id, blob, next.updated_at);
    },

    async load(src) {
      const id = assetIdOf(src);
      if (!id) return null;
      const row = await get<Asset>('asset', id);
      return row ? rowToBlob(row) : null;
    },

    resolve: resolveAsset,
    preload: preloadAssets,
  };
}
