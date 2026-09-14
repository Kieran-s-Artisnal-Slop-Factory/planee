/**
 * Excalidraw drawings — stored as ordinary image assets, but re-editable
 * forever.
 *
 * The trick is Excalidraw's `exportEmbedScene` flag: the exported PNG carries
 * the whole scene JSON inside it (a `tEXt` chunk), and `loadFromBlob` reads
 * it back. So a drawing needs no new storage, no new markdown syntax, and
 * nothing at all in the published page — it IS an image, which every surface
 * already handles. The files also open on excalidraw.com, and vice versa.
 *
 * `.excalidraw.png` is the convention that marks an image as re-editable;
 * `isDrawingRef` is the single place that decides.
 *
 * Excalidraw is React-only and heavy (~1 MB + React), so everything here
 * loads lazily — the drawing dialog is the only surface that pays for it.
 *
 * Ported from retoken (af25bc6) src/lib/excalidraw.ts. Changed: before the
 * module loads, `window.EXCALIDRAW_ASSET_PATH` points at the self-hosted fonts
 * in public/excalidraw/ (D14, base-aware through href()). Without it Excalidraw
 * fetches its hand-drawn fonts from esm.sh — a third-party request on every
 * canvas, and no fonts at all offline. Only Excalifont, Nunito and Cascadia
 * are hosted (scripts/copy-excalidraw-fonts.mjs); picking one of the other
 * font families in the canvas still falls back to esm.sh. Its stylesheet is
 * attached on load (lib/markdown/styles.ts) instead of imported as CSS.
 */
import { href } from './paths';
import { attachStyle } from './markdown/styles';

declare global {
  interface Window {
    /** Where Excalidraw looks for `fonts/<Family>/<file>.woff2`. */
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** The bits of the Excalidraw module we use, kept loose to avoid its types. */
export interface ExcalidrawModule {
  Excalidraw: unknown; // React component, handed straight to createElement
  exportToBlob: (opts: {
    elements: readonly unknown[];
    appState: Record<string, unknown>;
    files: unknown;
    mimeType?: string;
    quality?: number;
    exportPadding?: number;
    getDimensions?: (w: number, h: number) => { width: number; height: number; scale?: number };
  }) => Promise<Blob>;
  loadFromBlob: (
    blob: Blob,
    localAppState: unknown,
    localElements: unknown
  ) => Promise<{ elements: readonly unknown[]; appState: Record<string, unknown>; files: unknown }>;
}

export interface ReactModule {
  createElement: (type: unknown, props?: Record<string, unknown>, ...children: unknown[]) => unknown;
}

export interface ReactDomModule {
  createRoot: (container: Element) => { render: (node: unknown) => void; unmount: () => void };
}

export interface ExcalidrawBundle {
  excalidraw: ExcalidrawModule;
  react: ReactModule;
  reactDom: ReactDomModule;
}

let modulesPromise: Promise<ExcalidrawBundle> | null = null;

/**
 * Load Excalidraw + React on demand. Its CSS rides along with the same
 * import so the canvas is styled wherever it mounts.
 */
export function loadExcalidraw(): Promise<ExcalidrawBundle> {
  modulesPromise ??= (async () => {
    // Must be set before Excalidraw registers its font faces.
    window.EXCALIDRAW_ASSET_PATH = href('/excalidraw/');
    const [excalidraw, react, reactDom] = await Promise.all([
      import('@excalidraw/excalidraw') as unknown as Promise<ExcalidrawModule>,
      import('react') as unknown as Promise<ReactModule>,
      import('react-dom/client') as unknown as Promise<ReactDomModule>,
      // Inline + attached here rather than a CSS import, which Astro would
      // hoist into a <link> on every page that can reach this module.
      import('@excalidraw/excalidraw/index.css?inline').then((css) =>
        attachStyle('excalidraw', css.default)
      ),
    ]);
    return { excalidraw, react, reactDom };
  })();
  return modulesPromise;
}

/** Images written by the drawing dialog — the ones that can be reopened. */
export const DRAWING_SUFFIX = '.excalidraw.png';

/** Pixel density of exported drawings (2× reads crisply on retina). */
const EXPORT_SCALE = 2;

/** True when a markdown image ref is a re-editable drawing. */
export function isDrawingRef(src: string): boolean {
  return src.toLowerCase().split(/[?#]/)[0]!.endsWith(DRAWING_SUFFIX);
}

/**
 * A filename for a new drawing: `drawing.excalidraw.png`, or the author's
 * title slugified. The asset store de-duplicates collisions.
 */
export function drawingFilename(title = ''): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (slug || 'drawing') + DRAWING_SUFFIX;
}

/**
 * Render a scene to a PNG with the scene JSON embedded.
 *
 * The export is ALWAYS light-on-opaque, regardless of the theme the author
 * happens to be drawing in: the image ships to readers whose theme we can't
 * know, so baking in dark mode would hand them a black box on a light page.
 * Dark canvas while editing, canonical light on export — the same choice
 * excalidraw.com makes.
 */
export async function sceneToBlob(
  mod: ExcalidrawModule,
  scene: { elements: readonly unknown[]; appState: Record<string, unknown>; files: unknown }
): Promise<Blob> {
  return mod.exportToBlob({
    elements: scene.elements,
    files: scene.files,
    mimeType: 'image/png',
    appState: {
      ...scene.appState,
      // THE requirement: keeps the scene inside the PNG so it can reopen.
      exportEmbedScene: true,
      exportBackground: true,
      exportWithDarkMode: false,
    },
    // 2× for crisp rendering on high-DPI screens. The canvas dimensions must
    // be scaled TOO — returning the unscaled width/height alongside
    // `scale: 2` leaves the canvas at 1× while the content draws at 2×,
    // silently cropping the drawing to its top-left quarter.
    getDimensions: (width, height) => ({
      width: width * EXPORT_SCALE,
      height: height * EXPORT_SCALE,
      scale: EXPORT_SCALE,
    }),
  });
}

/** Read a drawing back into an editable scene (throws if it isn't one). */
export async function blobToScene(
  mod: ExcalidrawModule,
  blob: Blob
): Promise<{ elements: readonly unknown[]; appState: Record<string, unknown>; files: unknown }> {
  return mod.loadFromBlob(blob, null, null);
}
