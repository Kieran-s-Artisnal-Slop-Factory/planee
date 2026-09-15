<script lang="ts">
  /**
   * Create a version (used by /version and the FAB's "New Version").
   *
   * With `initialProject` the project is preselected and the number prefilled
   * with the next minor bump of that project's latest version (0.1.0 for a
   * project with none). Switching project re-suggests the number as long as
   * the user hasn't typed their own.
   *
   * Test hooks: version-create-form, version-create-project,
   * version-create-number, version-create-submit, version-create-completed,
   * version-create-description (MarkdownField prefix).
   */
  import { onMount } from 'svelte';
  import { all, put, withSyncFields } from '../../lib/db/repo';
  import type { Project, SyncFields, Version } from '../../lib/db/types';
  import { projectLabel } from '../../lib/crud';
  import { latestVersion, suggestNextNumber } from '../../lib/versions';
  import { FIRST_VERSION_NUMBER } from '../../lib/board/actions';
  import MarkdownField from '../markdown/MarkdownField.svelte';
  import { watchMarkdownEditing } from './markdownEditing';

  type VersionValues = Omit<Version, keyof SyncFields>;

  let {
    initialProject = null,
    onCreated = undefined,
    onCancel = undefined,
    autofocus = false,
  }: {
    initialProject?: string | null;
    onCreated?: (version: Version) => void;
    onCancel?: () => void;
    /** Focus the first empty field on mount (dialogs). */
    autofocus?: boolean;
  } = $props();

  const uid = $props.id();
  let projects: Project[] = $state([]);
  let versions: Version[] = $state([]);
  let draft = $state({ number: '', project: '', description: '', completed: false });
  /** The last number this form suggested; a number equal to it is still "untouched". */
  let suggested = '';
  let newProjectName = $state('');
  let formError: string | null = $state(null);
  let saving = $state(false);
  let formEl: HTMLFormElement | null = $state(null);
  let projectEl: HTMLSelectElement | null = $state(null);
  let numberEl: HTMLInputElement | null = $state(null);
  let markdownEditing = $state(false);

  $effect(() => watchMarkdownEditing(formEl, (editing) => (markdownEditing = editing)));

  function suggestFor(projectId: string): string {
    const own = versions.filter((v) => v.project === projectId);
    const latest = latestVersion(own);
    return latest ? suggestNextNumber(latest.number, own.map((v) => v.number)) : FIRST_VERSION_NUMBER;
  }

  function selectProject(projectId: string) {
    draft.project = projectId;
    if (!projectId) return;
    if (draft.number.trim() === '' || draft.number === suggested) {
      suggested = suggestFor(projectId);
      draft.number = suggested;
    }
  }

  onMount(async () => {
    [projects, versions] = await Promise.all([all<Project>('project'), all<Version>('version')]);
    projects.sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
    if (initialProject && projects.some((p) => p.id === initialProject)) selectProject(initialProject);
    if (autofocus) (draft.project ? numberEl : projectEl)?.focus();
  });

  /** Create a project row in place and select it. */
  async function createProjectInline() {
    const name = newProjectName.trim();
    if (!name) return;
    const created = await put('project', withSyncFields({ name, description: '' }));
    projects = [...projects, created];
    newProjectName = '';
    selectProject(created.id);
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (saving) return;
    formError = null;
    if (markdownEditing) {
      formError = 'Save or cancel the description first.';
      return;
    }
    const values: VersionValues = {
      number: draft.number.trim(),
      project: draft.project,
      description: draft.description === '' ? null : draft.description,
      completed: draft.completed,
    };
    if (!values.number || !values.project) {
      formError = 'A version needs a number and a project.';
      return;
    }
    saving = true;
    try {
      const created = await put('version', withSyncFields<VersionValues>(values));
      versions = [...versions, created];
      suggested = '';
      draft = { number: '', project: draft.project, description: '', completed: false };
      onCreated?.(created);
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<form class="stack create-form" data-testid="version-create-form" onsubmit={save} bind:this={formEl}>
  <div>
    <label for="{uid}-project">Project</label>
    <select
      id="{uid}-project"
      data-testid="version-create-project"
      value={draft.project}
      onchange={(e) => selectProject(e.currentTarget.value)}
      bind:this={projectEl}
      required
    >
      <option value="" disabled>Select…</option>
      {#each projects as opt (opt.id)}
        <option value={opt.id}>{projectLabel(opt)}</option>
      {/each}
    </select>
    <div class="inline-new">
      <input placeholder="New project name" bind:value={newProjectName} />
      <button type="button" class="btn btn-sm" onclick={createProjectInline} disabled={!newProjectName.trim()}>
        + New
      </button>
    </div>
  </div>
  <div>
    <label for="{uid}-number">Number</label>
    <input
      id="{uid}-number"
      data-testid="version-create-number"
      bind:value={draft.number}
      bind:this={numberEl}
      placeholder="0.1.0"
      required
    />
  </div>
  <div class="md-box">
    <MarkdownField
      label="Description"
      testid="version-create-description"
      value={draft.description}
      placeholder="No description yet."
      minHeight="8rem"
      onSave={async (md) => {
        draft.description = md;
      }}
    />
    <p class="hint md-note">Kept with the new version and stored when you create it.</p>
  </div>
  <div>
    <label class="check">
      <input type="checkbox" data-testid="version-create-completed" bind:checked={draft.completed} />
      Completed
    </label>
  </div>

  {#if formError}
    <p class="form-error">{formError}</p>
  {/if}
  <div class="row">
    <button
      class="btn btn-primary"
      data-testid="version-create-submit"
      type="submit"
      disabled={markdownEditing || saving}>Create version</button
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

  .inline-new {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .inline-new input {
    max-width: 16rem;
  }
</style>
