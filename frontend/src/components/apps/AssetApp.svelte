<script lang="ts">
  import { onMount } from 'svelte';
  import { all, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import type { Asset, Project, SyncFields, Task, Version } from '../../lib/db/types';
  import { ASSET_MAX_BYTES, assetRefsIn, bytesToBase64, humanSize } from '../../lib/assetRefs';

  let loading = $state(true);
  let rows: Asset[] = $state([]);
  /** asset id -> how many markdown fields reference it. */
  let useCounts: Map<string, number> = $state(new Map());
  let uploading = $state(false);
  let message: { kind: 'error' | 'ok'; text: string } | null = $state(null);
  let fileInput: HTMLInputElement | undefined = $state();

  /**
   * Every markdown field that can reference an asset (D7/D9). Tombstoned rows
   * are skipped: a reference from a deleted task does not keep an asset alive.
   */
  async function markdownFields(): Promise<(string | null)[]> {
    const [projects, versions, tasks] = await Promise.all([
      all<Project>('project'),
      all<Version>('version'),
      all<Task>('task'),
    ]);
    return [
      ...projects.map((p) => p.description),
      ...versions.map((v) => v.description),
      ...tasks.flatMap((t) => [t.description, t.subtasks]),
    ];
  }

  async function refresh() {
    const [assets, fields] = await Promise.all([all<Asset>('asset'), markdownFields()]);
    const counts = new Map<string, number>();
    for (const field of fields) {
      for (const id of assetRefsIn(field)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    useCounts = counts;
    rows = assets.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }

  onMount(async () => {
    await refresh();
    loading = false;
  });

  const usedBy = (asset: Asset) => useCounts.get(asset.id.toLowerCase()) ?? 0;
  const isImage = (asset: Asset) => asset.mime.startsWith('image/');
  const dataUrl = (asset: Asset) => `data:${asset.mime};base64,${asset.data}`;

  async function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    message = null;
    const tooBig = files.filter((f) => f.size > ASSET_MAX_BYTES);
    const ok = files.filter((f) => f.size <= ASSET_MAX_BYTES);
    uploading = true;
    try {
      for (const file of ok) {
        const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        await put(
          'asset',
          withSyncFields<Omit<Asset, keyof SyncFields>>({
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            data,
          })
        );
      }
    } catch (err) {
      message = { kind: 'error', text: 'Upload failed: ' + (err instanceof Error ? err.message : String(err)) };
    } finally {
      uploading = false;
    }
    if (tooBig.length > 0) {
      message = {
        kind: 'error',
        text:
          `Not uploaded — over the ${humanSize(ASSET_MAX_BYTES)} limit: ` +
          tooBig.map((f) => `${f.name} (${humanSize(f.size)})`).join(', '),
      };
    } else if (!message && ok.length > 0) {
      message = { kind: 'ok', text: `Uploaded ${ok.length} file${ok.length === 1 ? '' : 's'}.` };
    }
    await refresh();
  }

  async function del(asset: Asset) {
    const uses = usedBy(asset);
    if (uses > 0 && !confirm(`"${asset.name}" is used in ${uses} field${uses === 1 ? '' : 's'}. Delete it anyway?`)) {
      return;
    }
    await softDelete('asset', asset.id);
    await refresh();
  }
</script>

<div class="page-header">
  <h1>Assets</h1>
  <button
    class="btn btn-primary"
    data-testid="asset-upload"
    disabled={uploading}
    onclick={() => fileInput?.click()}
  >
    {uploading ? 'Uploading…' : '+ Upload'}
  </button>
  <input bind:this={fileInput} type="file" multiple hidden data-testid="asset-file" onchange={upload} />
</div>

{#if message}
  <p class={message.kind === 'error' ? 'form-error' : 'muted'} data-testid="asset-message">{message.text}</p>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">No assets yet. Images and drawings added to descriptions are stored here.</p>
{:else}
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Preview</th>
          <th>Name</th>
          <th>Type</th>
          <th>Size</th>
          <th>Used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="asset-row" data-row-id={row.id}>
            <td>
              {#if isImage(row)}
                <img class="thumb" src={dataUrl(row)} alt={row.name} loading="lazy" />
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
            <td>
              {row.name}
              <div class="mono muted">{row.id}</div>
            </td>
            <td class="mono">{row.mime}</td>
            <td>{humanSize(row.size)}</td>
            <td>
              {#if usedBy(row) > 0}
                <span class="badge badge-active" title="Referenced from {usedBy(row)} markdown field(s)">Used</span>
              {:else}
                <span class="badge">Unused</span>
              {/if}
            </td>
            <td class="actions">
              <button class="btn btn-sm btn-danger" data-testid="asset-delete" onclick={() => del(row)}>Delete</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }

  .thumb {
    display: block;
    width: 4rem;
    height: 4rem;
    object-fit: contain;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: var(--surface-color);
  }

  .mono {
    font-family: ui-monospace, monospace;
    font-size: var(--font-size-sm);
  }

  .form-error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }
</style>
