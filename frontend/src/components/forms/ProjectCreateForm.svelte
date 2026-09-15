<script lang="ts">
  /**
   * Create a project (used by /project and the FAB's "New Project").
   *
   * The description is a MarkdownField kept in the draft and written with the
   * row. With "Create first version" checked (the default) the project also
   * gets version 0.1.0 (FIRST_VERSION_NUMBER), so its board has somewhere to
   * start.
   *
   * Test hooks: project-create-form, project-create-name,
   * project-create-first-version, project-create-submit,
   * project-create-description (MarkdownField prefix).
   */
  import { onMount } from 'svelte';
  import { put, withSyncFields } from '../../lib/db/repo';
  import type { Project, SyncFields, Version } from '../../lib/db/types';
  import { createVersion, FIRST_VERSION_NUMBER } from '../../lib/board/actions';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import { watchMarkdownEditing } from './markdownEditing';

  type ProjectValues = Omit<Project, keyof SyncFields>;

  let {
    onCreated = undefined,
    onCancel = undefined,
    autofocus = false,
  }: {
    onCreated?: (project: Project, version?: Version) => void;
    onCancel?: () => void;
    /** Focus the name input on mount (dialogs). */
    autofocus?: boolean;
  } = $props();

  const uid = $props.id();
  let name = $state('');
  let description = $state('');
  let firstVersion = $state(true);
  let formError: string | null = $state(null);
  let saving = $state(false);
  let formEl: HTMLFormElement | null = $state(null);
  let nameEl: HTMLInputElement | null = $state(null);
  let markdownEditing = $state(false);

  $effect(() => watchMarkdownEditing(formEl, (editing) => (markdownEditing = editing)));

  onMount(() => {
    if (autofocus) nameEl?.focus();
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    formError = null;
    if (markdownEditing) {
      formError = 'Save or cancel the description first.';
      return;
    }
    const values: ProjectValues = { name: name.trim(), description };
    if (!values.name) {
      formError = 'A project needs a name.';
      return;
    }
    saving = true;
    try {
      const project = await put('project', withSyncFields<ProjectValues>(values));
      const version = firstVersion ? await createVersion(project.id, FIRST_VERSION_NUMBER) : undefined;
      name = '';
      description = '';
      onCreated?.(project, version);
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<form class="stack create-form" data-testid="project-create-form" onsubmit={save} bind:this={formEl}>
  <div>
    <label for="{uid}-name">Name</label>
    <input id="{uid}-name" data-testid="project-create-name" bind:value={name} bind:this={nameEl} required />
  </div>
  <div class="md-box">
    <MarkdownField
      label="Description"
      testid="project-create-description"
      value={description}
      placeholder="No description yet."
      minHeight="8rem"
      onSave={async (md) => {
        description = md;
      }}
    />
    <p class="hint md-note">Kept with the new project and stored when you create it.</p>
  </div>
  <label class="check">
    <input type="checkbox" data-testid="project-create-first-version" bind:checked={firstVersion} />
    Create first version {FIRST_VERSION_NUMBER}
  </label>

  {#if formError}
    <p class="form-error">{formError}</p>
  {/if}
  <div class="row">
    <button
      class="btn btn-primary"
      data-testid="project-create-submit"
      type="submit"
      disabled={markdownEditing || saving}>Create project</button
    >
    {#if onCancel}
      <button class="btn" type="button" onclick={() => onCancel?.()}>Cancel</button>
    {/if}
    {#if markdownEditing}
      <span class="hint">Save or cancel the description first.</span>
    {/if}
  </div>
</form>

<style>
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
