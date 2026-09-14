/**
 * Sync-mode default (plan D12 / finding 9): a build made with
 * PUBLIC_DEFAULT_SYNC_MODE=offline (GitHub Pages) must not sync against its
 * static host on load, while an explicit choice in Settings always wins.
 */
import { describe, expect, it } from 'vitest';
import { resolveSyncMode } from './sync';

describe('resolveSyncMode', () => {
  it('defaults to sync when nothing is stored and the build sets no default', () => {
    expect(resolveSyncMode(null, undefined)).toBe('sync');
    expect(resolveSyncMode(null, '')).toBe('sync');
  });

  it('defaults to offline when the build default is offline', () => {
    expect(resolveSyncMode(null, 'offline')).toBe('offline');
  });

  it('treats any other build default as sync', () => {
    expect(resolveSyncMode(null, 'sync')).toBe('sync');
    expect(resolveSyncMode(null, 'OFFLINE')).toBe('sync');
    expect(resolveSyncMode(null, 'nonsense')).toBe('sync');
  });

  it('lets an explicit stored choice override the build default in both directions', () => {
    expect(resolveSyncMode('sync', 'offline')).toBe('sync');
    expect(resolveSyncMode('offline', undefined)).toBe('offline');
    expect(resolveSyncMode('offline', 'sync')).toBe('offline');
  });

  it('ignores an unrecognised stored value and falls back to the build default', () => {
    expect(resolveSyncMode('garbage', 'offline')).toBe('offline');
    expect(resolveSyncMode('garbage', undefined)).toBe('sync');
  });
});
