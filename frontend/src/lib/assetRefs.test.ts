import { describe, expect, it } from 'vitest';
import {
  ASSET_MAX_BYTES,
  assetRefsIn,
  base64Size,
  base64ToBytes,
  bytesToBase64,
  humanSize,
} from './assetRefs';

const ID1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('assetRefsIn', () => {
  it('finds image and drawing references', () => {
    const md = `![shot](assets/${ID1}.png)\n\n![drawing](assets/${ID2}.excalidraw.png)`;
    expect(assetRefsIn(md)).toEqual([ID1, ID2]);
  });

  it('dedupes, keeps first-appearance order, and lower-cases', () => {
    const md = `assets/${ID2}.jpg then assets/${ID1.toUpperCase()}.PNG then assets/${ID2}.jpg`;
    expect(assetRefsIn(md)).toEqual([ID2, ID1]);
  });

  it('accepts ./ and / prefixes and link syntax', () => {
    expect(assetRefsIn(`[a](./assets/${ID1}.gif)`)).toEqual([ID1]);
    expect(assetRefsIn(`<img src="/assets/${ID1}.webp">`)).toEqual([ID1]);
  });

  it('ignores lookalikes', () => {
    expect(assetRefsIn(`myassets/${ID1}.png`)).toEqual([]); // different folder
    expect(assetRefsIn(`assets/${ID1}`)).toEqual([]); // no extension
    expect(assetRefsIn('assets/not-a-uuid.png')).toEqual([]);
    expect(assetRefsIn(`assets/${ID1.slice(0, -1)}.png`)).toEqual([]); // short uuid
    expect(assetRefsIn(`the id ${ID1} alone`)).toEqual([]);
  });

  it('handles empty input', () => {
    expect(assetRefsIn('')).toEqual([]);
    expect(assetRefsIn(null)).toEqual([]);
    expect(assetRefsIn(undefined)).toEqual([]);
  });

  it('is stateless across calls (global regex lastIndex)', () => {
    const md = `assets/${ID1}.png`;
    expect(assetRefsIn(md)).toEqual([ID1]);
    expect(assetRefsIn(md)).toEqual([ID1]);
  });
});

describe('base64', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect([...base64ToBytes(b64)]).toEqual([...bytes]);
  });

  it('handles inputs larger than one chunk', () => {
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 31) % 256);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64Size(b64)).toBe(bytes.length);
  });

  it('sizes without decoding, for every padding length', () => {
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const b64 = Buffer.alloc(n, 7).toString('base64');
      expect(base64Size(b64), `n=${n}`).toBe(n);
    }
  });
});

describe('humanSize', () => {
  it('formats binary units', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(1023)).toBe('1023 B');
    expect(humanSize(1024)).toBe('1 KB');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(20 * 1024)).toBe('20 KB');
    expect(humanSize(ASSET_MAX_BYTES)).toBe('5 MB');
    expect(humanSize(3 * 1024 ** 3)).toBe('3 GB');
  });

  it('refuses nonsense', () => {
    expect(humanSize(-1)).toBe('?');
    expect(humanSize(Number.NaN)).toBe('?');
  });
});
