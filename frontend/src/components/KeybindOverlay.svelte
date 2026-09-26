<script lang="ts">
  /**
   * Hold Ctrl to see the keys (D28). Mounted by Layout on every page.
   *
   * Ctrl pressed on its own and held for HOLD_MS shows:
   *   - BADGES: a <kbd> on every visible element carrying `data-keybind`
   *     (lib/ui/keybinds.ts parseBadgeAttr: ids, optional `@placement`) for a
   *     keybind this page has — fixed-positioned from getBoundingClientRect,
   *     re-measured on scroll and resize while shown. Focused-card badges only
   *     on the card that has focus. An element with several badges labels each
   *     with the last word of its id ("new", "focus").
   *   - A CHEAT SHEET: every keybind this page has, grouped Global / This page
   *     / Focused card, with its chords (the fallback outside an installed app,
   *     D25) and label. What cannot be used right now (a read-only version, no
   *     card focused, focus in a text field) is dimmed. The synced preference
   *     `preferences.show_keybind_sheet` turns it off, leaving only the badges;
   *     it is read on mount and again whenever preferences change (here, in
   *     another tab, or by sync).
   * Releasing Ctrl, pressing any other key (so a quick Ctrl+K never flashes
   * it), a pointer press, window blur or the tab being hidden takes it away.
   * It is not shown while a modal owns the keyboard (the keys are off then).
   *
   * It never takes focus or clicks (pointer-events: none, aria-hidden) and
   * never claims a key: the chords go on to the keybind listener as usual.
   * The sheet sits at the bottom centre, clear of the FAB, or at the top when
   * that covers less: the focused card counts most, then badges. The focused
   * card's own badges are drawn above the sheet, so they always show.
   *
   * Test hooks: keybind-overlay, keybind-badge (data-keybind-id),
   * keybind-sheet, keybind-sheet-row (data-keybind-id, data-available).
   */
  import { onMount, tick } from 'svelte';
  import { onChanged } from '../lib/db/changes';
  import { getSingleton } from '../lib/db/repo';
  import { DEFAULT_SHOW_KEYBIND_SHEET, type Preferences } from '../lib/db/types';
  import { chordLabel, isInstalledApp } from '../lib/ui/keys';
  import type { KeyScope } from '../lib/ui/keymap';
  import {
    displayChords,
    isModalOpen,
    keybindStatuses,
    parseBadgeAttr,
    type BadgePlacement,
    type DisplayOptions,
    type KeybindStatus,
  } from '../lib/ui/keybinds';

  const HOLD_MS = 400;

  interface BadgeItem {
    id: string;
    chord: string;
    short: string;
    available: boolean;
  }

  interface BadgeGroup {
    key: string;
    x: number;
    y: number;
    placement: BadgePlacement;
    items: BadgeItem[];
    /** On the focused card: covering it with the sheet costs the most. */
    card: boolean;
  }

  interface SheetRow {
    id: string;
    chords: string[];
    label: string;
    available: boolean;
  }

  let shown = $state(false);
  let statuses = $state<KeybindStatus[]>([]);
  let groups = $state<BadgeGroup[]>([]);
  let sheetEl = $state<HTMLElement>();
  let sheetAtTop = $state(false);
  /** preferences.show_keybind_sheet: off shows the badges alone. */
  let showSheet = $state(DEFAULT_SHOW_KEYBIND_SHEET);
  let opts: DisplayOptions = { installed: false, mac: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  const SECTIONS: { scope: KeyScope; title: string }[] = [
    { scope: 'global', title: 'Global' },
    { scope: 'home', title: 'This page' },
    { scope: 'card', title: 'Focused card' },
  ];

  const sections = $derived(
    SECTIONS.map((section) => ({
      ...section,
      rows: statuses
        .filter((status) => status.keybind.scope === section.scope)
        .map<SheetRow>((status) => ({
          id: status.keybind.id,
          chords: displayChords(status.keybind, opts).map(chordLabel),
          label: status.keybind.label,
          available: status.available,
        })),
    })).filter((section) => section.rows.length > 0)
  );
  const cardIdle = $derived(statuses.some((s) => s.keybind.scope === 'card') && !statuses.some((s) => s.keybind.scope === 'card' && s.available));
  /** D25: the primary chords a browser tab keeps for itself, which work in the installed app. */
  const reserved = $derived(
    opts.installed ? [] : statuses.filter((s) => s.keybind.fallback).map((s) => chordLabel(s.keybind.keys[0] ?? ''))
  );

  /** Where a badge group is anchored, from its element's box. */
  function anchor(rect: DOMRect, placement: BadgePlacement): { x: number; y: number } {
    const midX = rect.left + rect.width / 2;
    const midY = rect.top + rect.height / 2;
    switch (placement) {
      case 'top':
        return { x: midX, y: rect.top };
      case 'bottom':
        return { x: midX, y: rect.bottom };
      case 'left':
        return { x: rect.left, y: midY };
      case 'right':
        return { x: rect.right, y: midY };
      case 'beside':
        return { x: rect.left - 8, y: midY };
      default:
        return { x: rect.right + 8, y: rect.top };
    }
  }

  function measure() {
    frame = 0;
    if (!shown) return;
    const byId = new Map(statuses.map((status) => [status.keybind.id, status]));
    const active = document.activeElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const next: BadgeGroup[] = [];
    let n = 0;
    for (const el of document.querySelectorAll<HTMLElement>('[data-keybind]')) {
      n += 1;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      // Actually on screen: the middle of its visible part is the element itself
      // (not the sticky navbar it scrolled under, not a closed <details>).
      // The overlay is pointer-events: none, so it never counts as in the way.
      const cx = (Math.max(rect.left, 0) + Math.min(rect.right, vw)) / 2;
      const cy = (Math.max(rect.top, 0) + Math.min(rect.bottom, vh)) / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !(hit === el || el.contains(hit))) continue;
      const byPlacement = new Map<BadgePlacement, BadgeItem[]>();
      for (const { id, placement } of parseBadgeAttr(el.dataset.keybind)) {
        const status = byId.get(id);
        if (!status) continue;
        if (status.keybind.scope === 'card' && el !== active) continue;
        const chord = displayChords(status.keybind, opts)[0];
        if (!chord) continue;
        const items = byPlacement.get(placement) ?? [];
        items.push({ id, chord: chordLabel(chord), short: id.split('.').pop() ?? id, available: status.available });
        byPlacement.set(placement, items);
      }
      for (const [placement, items] of byPlacement) {
        const at = anchor(rect, placement);
        next.push({
          key: `${n}:${placement}`,
          x: Math.min(Math.max(at.x, 8), vw - 8),
          y: Math.min(Math.max(at.y, 12), vh - 12),
          placement,
          items,
          card: el === active && el.matches('[data-kanban-card]'),
        });
      }
    }
    groups = next;
  }

  function remeasure() {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  /**
   * Bottom or top: whichever covers less. The focused card (and its badges)
   * weigh most, any other badge one each; a tie stays at the bottom.
   */
  async function placeSheet() {
    sheetAtTop = false;
    await tick();
    if (!sheetEl || !shown) return;
    const bottom = sheetEl.getBoundingClientRect();
    const navbar = document.querySelector('.navbar')?.getBoundingClientRect().bottom ?? 0;
    const top = { left: bottom.left, right: bottom.right, top: navbar + 12, bottom: navbar + 12 + bottom.height };
    const active = document.activeElement;
    const card = active instanceof HTMLElement && active.matches('[data-kanban-card]') ? active.getBoundingClientRect() : null;
    const cost = (box: { left: number; right: number; top: number; bottom: number }) => {
      let total = 0;
      const pad = 16;
      for (const group of groups) {
        const inside =
          group.x > box.left - pad && group.x < box.right + pad && group.y > box.top - pad && group.y < box.bottom + pad;
        if (inside && !group.card) total += 1;
      }
      if (card) {
        // How much of the focused card it would hide, 0-1, far outweighing any badge.
        const w = Math.max(0, Math.min(card.right, box.right) - Math.max(card.left, box.left));
        const h = Math.max(0, Math.min(card.bottom, box.bottom + pad) - Math.max(card.top, box.top - pad));
        total += (1000 * w * h) / Math.max(1, card.width * card.height);
      }
      return total;
    };
    sheetAtTop = cost(top) < cost(bottom);
  }

  function show() {
    timer = undefined;
    if (shown || isModalOpen()) return;
    statuses = keybindStatuses();
    if (statuses.length === 0) return;
    shown = true;
    measure();
    window.addEventListener('scroll', remeasure, { capture: true, passive: true });
    window.addEventListener('resize', remeasure);
    if (showSheet) void placeSheet();
  }

  let prefSeq = 0;
  async function loadPreference() {
    const mine = ++prefSeq;
    try {
      const prefs = await getSingleton<Preferences>('preferences');
      if (mine === prefSeq) showSheet = prefs?.show_keybind_sheet ?? DEFAULT_SHOW_KEYBIND_SHEET;
    } catch {
      // IndexedDB unavailable: keep the default, the keys still work.
    }
  }

  function hide() {
    clearTimeout(timer);
    timer = undefined;
    if (!shown) return;
    shown = false;
    groups = [];
    sheetAtTop = false;
    cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener('scroll', remeasure, { capture: true });
    window.removeEventListener('resize', remeasure);
  }

  onMount(() => {
    opts = {
      installed: isInstalledApp(),
      mac: /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent),
    };
    void loadPreference();
    const stopPreference = onChanged(['preferences'], () => void loadPreference());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control') {
        // Held: the repeats are just the key still being down.
        if (event.repeat || shown || timer) return;
        // Ctrl as part of a chord someone is already holding (Shift+Ctrl…) is not "Ctrl alone".
        if (event.altKey || event.shiftKey || event.metaKey) return;
        timer = setTimeout(show, HOLD_MS);
        return;
      }
      hide();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control') hide();
    };
    const onVisibility = () => hide();
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', hide);
    window.addEventListener('pointerdown', hide, { capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      hide();
      stopPreference();
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', hide);
      window.removeEventListener('pointerdown', hide, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });
</script>

{#if shown}
  <div class="kbo" data-testid="keybind-overlay" aria-hidden="true">
    {#each groups as group (group.key)}
      <div class="kbo-group at-{group.placement}" class:raised={group.card} style="left: {group.x}px; top: {group.y}px">
        {#each group.items as item (item.id)}
          <kbd class="kbo-badge" class:off={!item.available} data-testid="keybind-badge" data-keybind-id={item.id}
            >{item.chord}{#if group.items.length > 1}<span class="kbo-short">{item.short}</span>{/if}</kbd
          >
        {/each}
      </div>
    {/each}

    {#if showSheet}
      <section class="kbo-sheet" class:top={sheetAtTop} data-testid="keybind-sheet" bind:this={sheetEl}>
        <header class="kbo-head">
          <strong>Keyboard shortcuts</strong>
          <span class="kbo-muted">release Ctrl to hide</span>
        </header>
        <div class="kbo-sections">
          {#each sections as section (section.scope)}
            <div class="kbo-section">
              <h2>{section.title}</h2>
              {#if section.scope === 'card' && cardIdle}
                <p class="kbo-muted kbo-note">Focus a card first (Ctrl+Shift+1/2/3).</p>
              {/if}
              <ul>
                {#each section.rows as row (row.id)}
                  <li
                    class:off={!row.available}
                    data-testid="keybind-sheet-row"
                    data-keybind-id={row.id}
                    data-available={row.available}
                  >
                    <span class="kbo-keys">
                      {#each row.chords as chord, i (chord)}
                        {#if i > 0}<span class="kbo-or">/</span>{/if}<kbd>{chord}</kbd>
                      {/each}
                    </span>
                    <span class="kbo-label">{row.label}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
        {#if reserved.length > 0}
          <p class="kbo-muted kbo-note">In the installed app, {reserved.join(' and ')} work too.</p>
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  .kbo {
    position: fixed;
    inset: 0;
    z-index: 95;
    pointer-events: none;
  }

  .kbo-group {
    position: fixed;
    display: flex;
    gap: var(--space-1);
    white-space: nowrap;
  }

  /* The focused card's badges: above the sheet, which may have to overlap it. */
  .kbo-group.raised {
    z-index: 2;
  }

  /* corner: straddle the top edge, right-aligned with the element's right edge */
  .kbo-group.at-corner {
    transform: translate(-100%, -50%);
  }

  .kbo-group.at-top,
  .kbo-group.at-bottom,
  .kbo-group.at-left,
  .kbo-group.at-right {
    transform: translate(-50%, -50%);
  }

  .kbo-group.at-beside {
    transform: translate(-100%, -50%);
  }

  .kbo-badge {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35em;
    padding: 0.1em 0.45em;
    border: 1px solid var(--color-primary-strong);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--color-primary);
    color: var(--color-on-primary);
    font-family: var(--font-mono);
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1.4;
    box-shadow: var(--shadow-2);
  }

  .kbo-badge.off {
    background: var(--surface-raised-color);
    border-color: var(--border-color);
    color: var(--text-muted-color);
    box-shadow: var(--shadow-1);
  }

  .kbo-short {
    font-family: var(--font-body);
    font-weight: 600;
    opacity: 0.85;
  }

  .kbo-sheet {
    position: fixed;
    z-index: 1;
    /* Centred in the band left of the FAB (3.5rem + its margin), never under it. */
    left: var(--space-4);
    right: calc(var(--space-5) + 4.5rem);
    bottom: max(var(--space-4), env(safe-area-inset-bottom));
    margin-inline: auto;
    max-width: 64rem;
    max-height: calc(100vh - var(--navbar-height) - 2 * var(--space-4));
    overflow: hidden;
    padding: var(--space-2) var(--space-4) var(--space-3);
    border: 1px solid var(--border-color);
    border-top: 3px double var(--detailed-gold, var(--color-primary));
    border-radius: var(--radius-lg);
    background: var(--surface-raised-color);
    color: var(--text-color);
    box-shadow: var(--shadow-2);
    font-size: 0.8rem;
    line-height: 1.35;
  }

  .kbo-sheet.top {
    bottom: auto;
    top: calc(var(--navbar-height) + var(--space-3));
  }

  .kbo-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .kbo-sections {
    display: grid;
    /* Three sections side by side down to ~50rem wide: short, so it rarely
       has to sit on anything. */
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--space-3) var(--space-4);
  }

  .kbo-section h2 {
    margin: 0 0 var(--space-1);
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted-color);
  }

  /* Keys in one column, labels in the next, aligned down the section. */
  .kbo-section ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.15rem var(--space-2);
  }

  .kbo-section li {
    display: grid;
    grid-column: span 2;
    grid-template-columns: subgrid;
    align-items: baseline;
  }

  .kbo-section li.off {
    opacity: 0.45;
  }

  .kbo-keys {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.2rem;
  }

  .kbo-keys kbd {
    font-size: 0.7rem;
    white-space: nowrap;
  }

  .kbo-or {
    color: var(--text-muted-color);
  }

  .kbo-muted {
    color: var(--text-muted-color);
  }

  .kbo-note {
    margin: 0 0 var(--space-1);
    font-size: 0.75rem;
  }

  .kbo-sheet > .kbo-note {
    margin: var(--space-2) 0 0;
  }

  @media print {
    .kbo {
      display: none;
    }
  }
</style>
