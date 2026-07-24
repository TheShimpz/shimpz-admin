<script>
  import { onMount } from 'svelte';
  import HelpMarkdown from '$lib/HelpMarkdown.svelte';
  import { locale, t } from '$lib/i18n.js';
  import {
    clearNotifications,
    dispatchAssistantRuntimeUpdated,
    getNotifications,
    readAllNotifications,
    readNotification,
    syncNotifications,
  } from '$lib/notifications.js';


  let dialog;
  let trigger;
  let open = $state(false);
  let view = $state('list');
  let selectedId = $state('');
  let notifications = $state([]);
  let unreadCount = $state(0);
  let ready = $state(false);
  let unavailable = $state(false);
  let actionBusy = $state(false);

  let copy = $derived($t('notifications'));
  let selected = $derived(notifications.find((notification) => notification.id === selectedId));
  let openLabel = $derived($t('notifications.open', { count: unreadCount }));

  function applySnapshot(snapshot) {
    notifications = [...snapshot.notifications];
    unreadCount = snapshot.unread_count;
    unavailable = false;
  }

  async function initialize() {
    try {
      applySnapshot(await getNotifications(fetch));
    } catch {
      unavailable = true;
    } finally {
      ready = true;
    }

    try {
      const snapshot = await syncNotifications(fetch);
      applySnapshot(snapshot);
      if (snapshot.sync.updated_assistants > 0) dispatchAssistantRuntimeUpdated();
    } catch {
      // Notification refresh is deliberately best-effort and must never block local Admin access.
    }
  }

  async function refresh() {
    try {
      applySnapshot(await getNotifications(fetch));
    } catch {
      if (notifications.length === 0) unavailable = true;
    }
  }

  function showDrawer() {
    view = 'list';
    selectedId = '';
    open = true;
    void refresh();
  }

  function closeDrawer() {
    open = false;
    view = 'list';
    selectedId = '';
  }

  function cancel(event) {
    event.preventDefault();
    closeDrawer();
  }

  function choose(notification) {
    selectedId = notification.id;
    view = 'detail';
    if (notification.read_at === null) {
      void readNotification(fetch, notification.id).then(applySnapshot).catch(() => {});
    }
  }

  async function markAllRead() {
    if (actionBusy || unreadCount === 0) return;
    actionBusy = true;
    try {
      applySnapshot(await readAllNotifications(fetch));
    } catch {
      // Keep the existing local snapshot; a later refresh can retry.
    } finally {
      actionBusy = false;
    }
  }

  async function clearAll() {
    if (actionBusy || notifications.length === 0) return;
    actionBusy = true;
    try {
      applySnapshot(await clearNotifications(fetch));
      view = 'list';
      selectedId = '';
    } catch {
      // Keep the existing local snapshot; clearing is safe to retry.
    } finally {
      actionBusy = false;
    }
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat($locale, { dateStyle: 'medium' }).format(new Date(value));
    } catch {
      return value;
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  onMount(() => {
    void initialize();
  });
</script>

<button
  bind:this={trigger}
  class="notification-trigger"
  class:has-unread={unreadCount > 0}
  type="button"
  aria-label={openLabel}
  aria-haspopup="dialog"
  aria-expanded={open}
  onclick={showDrawer}
>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 6 2.25 6 2.25 7.5H4.25c0-1.5 2.25-1.5 2.25-7.5Z"></path>
    <path d="M9.75 19a2.5 2.5 0 0 0 4.5 0"></path>
  </svg>
  {#if unreadCount > 0}
    <span class="notification-badge" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>
  {/if}
</button>

<dialog
  bind:this={dialog}
  aria-labelledby="notification-center-title"
  oncancel={cancel}
  onclose={() => { open = false; }}
>
  <section class="notification-drawer">
    <header>
      <div>
        <p>{copy.kicker}</p>
        <h2 id="notification-center-title">{copy.label}</h2>
      </div>
      <button class="icon-button" type="button" aria-label={copy.close} title={copy.close} onclick={closeDrawer}>×</button>
    </header>

    {#if view === 'detail' && selected}
      <div class="detail-toolbar">
        <button type="button" onclick={() => { view = 'list'; selectedId = ''; }}>← {copy.back}</button>
      </div>
      <article class="notification-detail">
        <p class="assistant-id">{copy.assistant} // {selected.assistant_id}</p>
        <h3>{selected.headline}</h3>
        <time datetime={selected.published_at}>
          {$t('notifications.published', { date: formatDate(selected.published_at) })}
        </time>
        <div class="changelog"><HelpMarkdown markdown={selected.changelog} /></div>
      </article>
    {:else}
      <div class="notification-actions">
        <button type="button" disabled={actionBusy || unreadCount === 0} onclick={markAllRead}>{copy.markAll}</button>
        <button class="clear-button" type="button" disabled={actionBusy || notifications.length === 0} onclick={clearAll}>{copy.clear}</button>
      </div>

      <div class="notification-list" aria-busy={!ready} aria-live="polite">
        {#if notifications.length > 0}
          {#each notifications as notification (notification.id)}
            <button
              class="notification-item"
              class:unread={notification.read_at === null}
              type="button"
              onclick={() => choose(notification)}
            >
              <span class="status-dot" aria-hidden="true"></span>
              <span class="notification-copy">
                <strong>{notification.headline}</strong>
                <small>{notification.assistant_id} · {formatDate(notification.published_at)}</small>
              </span>
              <span class="read-state">{notification.read_at === null ? copy.unread : copy.read}</span>
            </button>
          {/each}
        {:else if ready}
          <p class="empty-state">{unavailable ? copy.unavailable : copy.empty}</p>
        {/if}
      </div>
    {/if}
  </section>
</dialog>

<style>
  .notification-trigger,
  button {
    font: inherit;
  }

  .notification-trigger {
    position: relative;
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    flex: none;
    place-items: center;
    border: 1px solid var(--border-strong);
    padding: 0;
    background: #030506;
    color: var(--text-dim);
    cursor: pointer;
  }

  .notification-trigger:hover,
  .notification-trigger.has-unread {
    color: var(--accent);
  }

  .notification-trigger svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: square;
    stroke-linejoin: miter;
    stroke-width: 1.5;
  }

  .notification-badge {
    position: absolute;
    inset-block-start: -0.35rem;
    inset-inline-end: -0.35rem;
    display: grid;
    min-width: 1rem;
    height: 1rem;
    place-items: center;
    border: 1px solid #000;
    padding: 0 0.18rem;
    background: var(--danger);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 0.48rem;
    font-weight: 700;
    line-height: 1;
  }

  dialog {
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    width: min(31rem, 100vw);
    height: 100vh;
    height: 100dvh;
    max-width: 100vw;
    max-height: none;
    margin: 0;
    margin-inline-start: auto;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }

  dialog::backdrop {
    background: rgba(0, 0, 0, 0.76);
    backdrop-filter: blur(5px);
  }

  .notification-drawer {
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto auto minmax(0, 1fr);
    border-inline-start: 1px solid var(--border-strong);
    background:
      linear-gradient(rgba(0, 240, 255, 0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 240, 255, 0.025) 1px, transparent 1px),
      #030506;
    background-size: 48px 48px;
    box-shadow: -1rem 0 3rem rgba(0, 0, 0, 0.7);
  }

  header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 1rem;
    border-bottom: 1px solid var(--border-strong);
    padding: 1.4rem;
  }

  header p,
  .assistant-id {
    margin: 0 0 0.45rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  h2,
  h3 { margin: 0; }
  h2 { font-size: clamp(1.55rem, 4vw, 2.25rem); letter-spacing: -0.05em; }
  h3 { margin-top: 0.35rem; font-size: 1.35rem; line-height: 1.2; }

  .icon-button {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border: 1px solid var(--border-strong);
    padding: 0;
    background: #030506;
    color: var(--accent);
    cursor: pointer;
    font-size: 1.15rem;
  }

  .notification-actions,
  .detail-toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.55rem;
    border-bottom: 1px solid var(--border-strong);
    padding: 0.8rem 1.4rem;
  }

  .notification-actions button,
  .detail-toolbar button {
    min-height: 2.25rem;
    border: 1px solid var(--border-strong);
    padding: 0 0.75rem;
    background: #030506;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.55rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  .detail-toolbar { justify-content: flex-start; }
  .notification-actions .clear-button { color: var(--danger); }
  button:disabled { cursor: not-allowed; opacity: 0.38; }

  .notification-list,
  .notification-detail {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .notification-list { padding: 0.75rem 0; }

  .notification-item {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.7rem;
    border: 0;
    border-inline-start: 2px solid transparent;
    padding: 0.9rem 1.4rem;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    text-align: start;
  }

  .notification-item:hover,
  .notification-item:focus-visible {
    background: rgba(0, 240, 255, 0.055);
    color: var(--text);
  }

  .notification-item.unread {
    border-inline-start-color: var(--accent);
    color: var(--text);
  }

  .status-dot {
    width: 0.35rem;
    height: 0.35rem;
    margin-top: 0.35rem;
    background: var(--text-faint);
    border-radius: 50%;
  }

  .unread .status-dot {
    background: var(--accent);
    box-shadow: 0 0 0.5rem rgba(0, 240, 255, 0.8);
  }

  .notification-copy { display: grid; min-width: 0; gap: 0.35rem; }
  .notification-copy strong { font-size: 0.78rem; line-height: 1.4; }
  .notification-copy small,
  .read-state,
  time {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 0.53rem;
    letter-spacing: 0.06em;
  }

  .read-state { color: inherit; text-transform: uppercase; }
  .empty-state { margin: 2rem 1.4rem; color: var(--text-faint); font-size: 0.75rem; line-height: 1.6; }

  .notification-detail { padding: 1.4rem; }
  .notification-detail time { display: block; margin-top: 0.6rem; }
  .changelog { margin-top: 1.5rem; border-top: 1px solid var(--border-strong); padding-top: 1.25rem; }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  @media (max-width: 520px) {
    dialog { width: 100vw; }
    .notification-actions { justify-content: stretch; }
    .notification-actions button { flex: 1 1 auto; }
    .notification-item { padding-inline: 1rem; }
    header, .notification-detail { padding-inline: 1rem; }
  }
</style>
