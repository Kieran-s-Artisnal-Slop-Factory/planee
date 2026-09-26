import { describe, expect, it } from 'vitest';
import {
  assetExtension,
  assetIdOf,
  assetMime,
  assetSrc,
  assetTooLargeMessage,
  dbAssets,
  resolveAsset,
} from './assets';
import { ASSET_MAX_BYTES } from './assetRefs';

const UUID = '0b9f7c3e-2a41-4c5d-9e8f-1a2b3c4d5e6f';

describe('assetIdOf', () => {
  it('reads the uuid out of an asset ref', () => {
    expect(assetIdOf(`assets/${UUID}.png`)).toBe(UUID);
    expect(assetIdOf(`assets/${UUID}.excalidraw.png`)).toBe(UUID);
  });

  it('lower-cases the id, as assetRefsIn does', () => {
    expect(assetIdOf(`assets/${UUID.toUpperCase()}.PNG`)).toBe(UUID);
  });

  it('accepts ./ and / prefixes and ignores a query or hash', () => {
    expect(assetIdOf(`./assets/${UUID}.png`)).toBe(UUID);
    expect(assetIdOf(`/assets/${UUID}.png?v=2#x`)).toBe(UUID);
  });

  it('is null for anything that is not exactly an asset ref', () => {
    expect(assetIdOf('images/a.png')).toBeNull();
    expect(assetIdOf(`myassets/${UUID}.png`)).toBeNull();
    expect(assetIdOf(`assets/${UUID}`)).toBeNull();
    expect(assetIdOf(`https://example.com/assets/${UUID}.png`)).toBeNull();
    expect(assetIdOf('assets/not-a-uuid.png')).toBeNull();
  });
});

describe('assetExtension', () => {
  it('keeps the compound drawing extension', () => {
    expect(assetExtension('drawing.excalidraw.png')).toBe('excalidraw.png');
    expect(assetExtension('My Sketch.Excalidraw.PNG')).toBe('excalidraw.png');
  });

  it('uses the last extension of anything else, lower-cased', () => {
    expect(assetExtension('photo.JPG')).toBe('jpg');
    expect(assetExtension('archive.tar.gz')).toBe('gz');
  });

  it('falls back to the MIME type, then to bin', () => {
    expect(assetExtension('pasted', 'image/png')).toBe('png');
    expect(assetExtension('', 'image/svg+xml')).toBe('svg');
    expect(assetExtension('.hidden', 'image/jpeg')).toBe('jpg');
    expect(assetExtension('weird.p-n-g', 'application/x-thing')).toBe('bin');
  });

  it('round-trips through assetSrc and assetIdOf', () => {
    const src = assetSrc(UUID, assetExtension('drawing.excalidraw.png'));
    expect(src).toBe(`assets/${UUID}.excalidraw.png`);
    expect(assetIdOf(src)).toBe(UUID);
  });
});

describe('assetMime', () => {
  it("prefers the blob's own type", () => {
    expect(assetMime('a.png', 'image/webp')).toBe('image/webp');
  });

  it('guesses from the extension otherwise', () => {
    expect(assetMime('a.jpeg')).toBe('image/jpeg');
    expect(assetMime('d.excalidraw.png')).toBe('image/png');
    expect(assetMime('notes.xyz')).toBe('application/octet-stream');
  });
});

describe('dbAssets size cap', () => {
  it('refuses a file over 5 MB with a readable message, before touching the database', async () => {
    const big = new Blob([new Uint8Array(ASSET_MAX_BYTES + 1)], { type: 'image/png' });
    await expect(dbAssets().save(big, 'huge.png')).rejects.toThrow(/huge\.png.*at most 5 MB/);
  });

  it('names the file and both sizes', () => {
    expect(assetTooLargeMessage('a.png', 5 * 1024 * 1024 + 10)).toBe(
      '“a.png” is too large (5.00 MB): images and drawings can be at most 5 MB.'
    );
  });
});

describe('resolveAsset', () => {
  it('is undefined for an asset that was never preloaded', () => {
    expect(resolveAsset(`assets/${UUID}.png`)).toBeUndefined();
    expect(resolveAsset('images/a.png')).toBeUndefined();
  });
});
