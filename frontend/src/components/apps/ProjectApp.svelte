<script lang="ts">
  import { onMount } from 'svelte';
  import { all, get, patch, softDelete } from '../../lib/db/repo';
  import { onChanged } from '../../lib/db/changes';
  import { recordView } from '../../lib/ui/recent';
  import type { Project, SyncFields } from '../../lib/db/types';
  import { changedFields } from '../../lib/crud';
  import Card from '../Card.svelte';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import MarkdownCell from '../markdown/MarkdownCell.svelte';
  import ProjectCreateForm from '../forms/ProjectCreateForm.svelte';

  type ProjectValues = Omit<Project, keyof SyncFields>;

  let loading = $state(true);
  let rows: Project[] = $state([]);

  /** The "+ New" form (ProjectCreateForm) is open. */
  let creating = $state(false);
  let editingId: string | null = $state(null); // null = closed, else the project being edited
  let editingOriginal: ProjectValues | null = null; // the row as it was when Edit was clicked
  let formError: string | null = $state(null);
  let draft = $state(blankDraft());

  let formEl: HTMLFormElement | null = $state(null);
  /**
   * True while the description's MarkdownField is open in its editor. The
   * form's own Save is disabled meanwhile, so submitting cannot close the
   * form over the unsaved text.
   * Read from the DOM: the field's Save button exists only while editing.
   */
  let markdownEditing = $state(false);
  $effect(() => {
    const form = formEl;
    if (!form) {
      markdownEditing = false;
      return;
    }
    const check = () => (markdownEditing = form.querySelector('[data-testid="project-description-save"]') !== null);
    const observer = new MutationObserver(check);
    observer.observe(form, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  });

  function blankDraft(): ProjectValues {
    return {
      name: '',
      description: '',
    };
  }

  async function refresh() {
    rows = await all<Project>('project');
  }

  onMount(() => {
    // Live: rows created elsewhere (the FAB, another tab, a sync) show up. Read-only.
    const stop = onChanged(['project'], () => void refresh());
    void refresh().then(() => (loading = false));
    return stop;
  });

  function startCreate() {
    editingId = null;
    creating = true;
  }

  function startEdit(row: Project) {
    draft = {
      name: row.name ?? '',
      description: row.description ?? '',
    };
    editingOriginal = { ...draft };
    formError = null;
    creating = false;
    editingId = row.id;
    recordView('project', row.id);
  }

  /** An existing row's description: its own Save patches just that field, straight away (D10). */
  async function saveDescription(md: string) {
    const id = editingId;
    if (!id) return;
    const saved = await patch<Project>('project', id, { description: md });
    if (!saved) throw new Error('That row was deleted somewhere else — nothing was saved.');
    draft.description = md;
    if (editingOriginal) editingOriginal.description = md;
    await refresh();
  }

  /** The stored description right now, so a concurrent change is caught before it is overwritten. */
  async function freshDescription() {
    const row = editingId ? await get<Project>('project', editingId) : undefined;
    if (!row) throw new Error('That row was deleted somewhere else — nothing was saved.');
    return row.description ?? '';
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    if (markdownEditing) {
      formError = 'Save or cancel the description first.';
      return;
    }
    const values: ProjectValues = {
      name: draft.name.trim(),
      description: draft.description,
    };
    if (!values.name) {
      formError = 'A project needs a name.';
      return;
    }
    const id = editingId;
    if (!id) return;
    // patch() re-reads the row from the store and changes ONLY the fields
    // named — and only the ones the user actually changed are named, so an
    // untouched field keeps its per-field stamp and a concurrent edit to it
    // on another device still wins.
    const changes: Partial<ProjectValues> = editingOriginal ? changedFields(editingOriginal, values) : { ...values };
    // The description is not this button's: its MarkdownField saved it already.
    delete changes.description;
    if (Object.keys(changes).length > 0) {
      const saved = await patch<Project>('project', id, changes);
      if (!saved) {
        formError = 'That row was deleted somewhere else — nothing was saved.';
        await refresh();
        return;
      }
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

{#if creating}
  <Card title="New project">
    <ProjectCreateForm
      autofocus
      onCreated={() => {
        creating = false;
        void refresh();
      }}
      onCancel={() => (creating = false)}
    />
  </Card>
{/if}

{#if editingId !== null}
  {#key editingId}
  <Card title="Edit">
    <form class="stack" onsubmit={save} bind:this={formEl}>
      <div>
        <label for="f-name">Name</label>
        <input id="f-name" bind:value={draft.name} required />
      </div>
      <div class="md-box">
        <MarkdownField
          label="Description"
          testid="project-description"
          value={draft.description}
          placeholder="No description yet."
          minHeight="8rem"
          onSave={saveDescription}
          getFresh={freshDescription}
        />
        <p class="hint md-note">Saved on its own with its Save button.</p>
      </div>

      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <div class="row">
        <button class="btn btn-primary" data-testid="project-save" type="submit" disabled={markdownEditing}>Save</button>
        <button class="btn" type="button" onclick={() => (editingId = null)}>Cancel</button>
        {#if markdownEditing}
          <span class="hint">Save or cancel the description first.</span>
        {/if}
      </div>
    </form>
  </Card>
  {/key}
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
            <td><MarkdownCell markdown={row.description} testid="project-description-cell" /></td>
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

  .md-box {
    padding: var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
  }

  .md-note {
    margin: var(--space-2) 0 0;
  }

  .form-error {
    color: var(--color-danger);
    font-size: var(--font-size-sm);
  }
</style>
