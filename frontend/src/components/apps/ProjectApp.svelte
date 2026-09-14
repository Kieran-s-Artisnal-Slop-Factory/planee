<script lang="ts">
  import { onMount } from 'svelte';
  import { all, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import type { Project, SyncFields } from '../../lib/db/types';
  import Card from '../Card.svelte';

  let loading = $state(true);
  let rows: Project[] = $state([]);


  let editingId: string | null = $state(null); // null = closed, '' = new row
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());


  function blankDraft() {
    return {
    description: '',
    version: '',
    };
  }





  async function refresh() {
    rows = await all<Project>('project');


  }

  onMount(async () => {
    await refresh();
    loading = false;
  });

  function startCreate() {
    draft = blankDraft();

    formError = null;
    editingId = '';
  }

  function startEdit(row: Project) {
    draft = {
      description: row.description ?? '',
      version: row.version ?? '',
    };

    formError = null;
    editingId = row.id;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    let values: Omit<Project, keyof SyncFields>;
    try {
      values = {
      description: draft.description,
      version: draft.version,
      };
    } catch (err) {
      formError = 'Invalid JSON: ' + (err instanceof Error ? err.message : String(err));
      return;
    }
    let savedId: string;
    if (editingId) {
      // patch() re-reads the row from the store and changes ONLY these fields.
      // Writing `{ ...rowFromTheList, ...values }` instead would push the
      // component's snapshot back over anything that changed underneath it —
      // an edit pulled from another device, a change made in another tab —
      // and that reversion then propagates as if it were deliberate.
      const saved = await patch<Project>('project', editingId, values);
      if (!saved) {
        formError = 'That row was deleted somewhere else — nothing was saved.';
        await refresh();
        return;
      }
      savedId = editingId;
    } else {
      const created = await put('project', withSyncFields(values));
      savedId = created.id;
    }

    editingId = null;
    await refresh();
  }

  async function del(row: Project) {
    if (!confirm('Delete this row?')) return;
    await softDelete('project', row.id);
    await refresh();
  }
</script>

<div class="page-header">
  <h1>Project</h1>
  <button class="btn btn-primary" data-testid="project-new" onclick={startCreate}>+ New</button>
</div>

{#if editingId !== null}
  <Card title={editingId ? 'Edit' : 'New project'}>
    <form class="stack" onsubmit={save}>
      <div>
        <label for="f-description">Description</label>
        <input id="f-description" bind:value={draft.description} required />
      </div>
      <div>
        <label for="f-version">Version</label>
        <input id="f-version" bind:value={draft.version} required />
      </div>

      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="project-save" type="submit">Save</button>
        <button class="btn" type="button" onclick={() => (editingId = null)}>Cancel</button>
      </div>
    </form>
  </Card>
{/if}

{#if loading}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">Nothing here yet.</p>
{:else}
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>Version</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="project-row" data-row-id={row.id}>
            <td>{row.description ?? ''}</td>
            <td>{row.version ?? ''}</td>
            <td class="actions">
              <button class="btn btn-sm" data-testid="project-edit" onclick={() => startEdit(row)}>Edit</button>
              <button class="btn btn-sm btn-danger" data-testid="project-delete" onclick={() => del(row)}>Delete</button>
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

  .mono {
    font-family: ui-monospace, monospace;
    font-size: var(--font-size-sm);
  }

  .form-error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }

  .inline-new {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .inline-new input {
    max-width: 16rem;
  }

  .link-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    padding: var(--space-2) 0;
  }

  .link-item {
    margin: 0;
  }
</style>
