<script>
  import { Button, Modal, Panel } from '@shimpz/frontend';
  import { onMount } from 'svelte';
  import Markdown from '$lib/Markdown.svelte';
  import { locale, t } from '$lib/i18n.js';
  import {
    clearNotifications,
    dispatchAssistantRuntimeUpdated,
    getNotifications,
    readAllNotifications,
    readNotification,
    syncNotifications,
  } from '$lib/notifications.js';


  let dialog = $state();
  let trigger = $state();
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

<Button
  bind:element={trigger}
  variant="ghost"
  size="icon"
  class={`notification-trigger${unreadCount > 0 ? ' has-unread' : ''}`}
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
</Button>

<Modal
  bind:element={dialog}
  class="notification-modal"
  labelledBy="notification-center-title"
  oncancel={cancel}
  onclose={() => { open = false; }}
>
  <Panel class="notification-drawer" tone="accent">
    <header>
      <div>
        <p>{copy.kicker}</p>
        <h2 id="notification-center-title">{copy.label}</h2>
      </div>
      <Button variant="ghost" size="icon" type="button" aria-label={copy.close} title={copy.close} onclick={closeDrawer}>×</Button>
    </header>

    {#if view === 'detail' && selected}
      <div class="detail-toolbar">
        <Button variant="ghost" size="compact" type="button" onclick={() => { view = 'list'; selectedId = ''; }}>← {copy.back}</Button>
      </div>
      <article class="notification-detail">
        <p class="assistant-id">{copy.assistant} // {selected.assistant_id}</p>
        <h3>{selected.headline}</h3>
        <time datetime={selected.published_at}>
          {$t('notifications.published', { date: formatDate(selected.published_at) })}
        </time>
        <div class="changelog"><Markdown markdown={selected.changelog} /></div>
      </article>
    {:else}
      <div class="notification-actions">
        <Button variant="secondary" size="compact" type="button" disabled={actionBusy || unreadCount === 0} onclick={markAllRead}>{copy.markAll}</Button>
        <Button variant="danger" size="compact" type="button" disabled={actionBusy || notifications.length === 0} onclick={clearAll}>{copy.clear}</Button>
      </div>

      <div class="notification-list" aria-busy={!ready} aria-live="polite">
        {#if notifications.length > 0}
          {#each notifications as notification (notification.id)}
            <Button
              variant="ghost"
              class={`notification-item${notification.read_at === null ? ' unread' : ''}`}
              type="button"
              onclick={() => choose(notification)}
            >
              <span class="status-dot" aria-hidden="true"></span>
              <span class="notification-copy">
                <strong>{notification.headline}</strong>
                <small>{notification.assistant_id} · {formatDate(notification.published_at)}</small>
              </span>
              <span class="read-state">{notification.read_at === null ? copy.unread : copy.read}</span>
            </Button>
          {/each}
        {:else if ready}
          <p class="empty-state">{unavailable ? copy.unavailable : copy.empty}</p>
        {/if}
      </div>
    {/if}
  </Panel>
</Modal>

<style>
  :global(.notification-trigger) {
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

  :global(.notification-trigger:hover),
  :global(.notification-trigger.has-unread) {
    color: var(--accent);
  }

  :global(.notification-trigger) svg {
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

  :global(.notification-drawer) {
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto auto minmax(0, 1fr);
    border-inline-start: 1px solid var(--border-strong);
    background: var(--surface-1);
    box-shadow: -1rem 0 3rem rgba(0, 0, 0, 0.7);
  }

  :global(.notification-modal) {
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    width: min(28rem, 100vw);
    height: 100dvh;
    max-height: none;
    margin: 0;
    margin-inline-start: auto;
  }

  header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.75rem;
    border-bottom: 1px solid var(--border-strong);
    padding: 1.1rem;
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
  h2 { font-size: clamp(1.3rem, 3.5vw, 1.8rem); letter-spacing: -0.045em; }
  h3 { margin-top: 0.3rem; font-size: 1.1rem; line-height: 1.25; }

  .notification-actions,
  .detail-toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.45rem;
    border-bottom: 1px solid var(--border-strong);
    padding: 0.65rem 1.1rem;
  }

  .detail-toolbar { justify-content: flex-start; }

  .notification-list,
  .notification-detail {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .notification-list { padding: 0.5rem 0; }

  :global(.notification-item) {
    display: grid;
    width: 100%;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.7rem;
    border: 0;
    border-inline-start: 2px solid transparent;
    padding: 0.7rem 1.1rem;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    text-align: start;
  }

  :global(.notification-item:hover),
  :global(.notification-item:focus-visible) {
    background: rgba(0, 240, 255, 0.055);
    color: var(--text);
  }

  :global(.notification-item.unread) {
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

  :global(.notification-item.unread) .status-dot {
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

  @media (max-width: 520px) {
    :global(.notification-modal) { width: 100vw; }
    .notification-actions { justify-content: stretch; }
    .notification-actions :global(.shimpz-button) { flex: 1 1 auto; }
    :global(.notification-item) { padding-inline: 1rem; }
    header, .notification-detail { padding-inline: 1rem; }
  }
</style>
