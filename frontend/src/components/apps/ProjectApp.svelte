<script lang="ts">
  import { onMount } from 'svelte';
  import { all, patch, put, softDelete, withSyncFields } from '../../lib/db/repo';
  import type { Project, SyncFields } from '../../lib/db/types';
  import { changedFields } from '../../lib/crud';
  import Card from '../Card.svelte';

  type ProjectValues = Omit<Project, keyof SyncFields>;

  let loading = $state(true);
  let rows: Project[] = $state([]);

  let editingId: string | null = $state(null); // null = closed, '' = new row
  let editingOriginal: ProjectValues | null = null; // the row as it was when Edit was clicked
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());

  function blankDraft(): ProjectValues {
    return {
      name: '',
      description: '',
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
    editingOriginal = null;
    formError = null;
    editingId = '';
  }

  function startEdit(row: Project) {
    draft = {
      name: row.name ?? '',
      description: row.description ?? '',
    };
    editingOriginal = { ...draft };
    formError = null;
    editingId = row.id;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    const values: ProjectValues = {
      name: draft.name.trim(),
      description: draft.description,
    };
    if (!values.name) {
      formError = 'A project needs a name.';
      return;
    }
    if (editingId) {
      // patch() re-reads the row from the store and changes ONLY the fields
      // named — and only the ones the user actually changed are named, so an
      // untouched field keeps its per-field stamp and a concurrent edit to it
      // on another device still wins.
      const changes = editingOriginal ? changedFields(editingOriginal, values) : values;
      if (Object.keys(changes).length > 0) {
        const saved = await patch<Project>('project', editingId, changes);
        if (!saved) {
          formError = 'That row was deleted somewhere else — nothing was saved.';
          await refresh();
          return;
        }
      }
    } else {
      await put('project', withSyncFields<ProjectValues>(values));
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
        <label for="f-name">Name</label>
        <input id="f-name" bind:value={draft.name} required />
      </div>
      <div>
        <label for="f-description">Description</label>
        <textarea id="f-description" rows="4" bind:value={draft.description}></textarea>
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
          <th>Name</th>
          <th>Description</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-testid="project-row" data-row-id={row.id}>
            <td>{row.name || '(unnamed)'}</td>
            <td class="pre">{row.description ?? ''}</td>
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

  .pre {
    white-space: pre-wrap;
    max-width: 40ch;
  }

  .form-error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }
</style>
