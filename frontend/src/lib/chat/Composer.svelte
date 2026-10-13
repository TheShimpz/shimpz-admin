<script>
  import { Button, FileInput, Notice, TextAreaField, TextField, Toolbar } from '@shimpz/frontend';
  import { commandsReady } from '#lib/session/socket.js';
  import { MAX_ATTACHMENTS } from '#lib/chat/attachments/files.js';
  import BrainMenu from '#lib/brain/Menu.svelte';
  import ComposerAttachments from '#lib/chat/attachments/ComposerFiles.svelte';
  import FastRoutingMenu from '#lib/brain/FastRoutingMenu.svelte';
  import { t } from '#lib/i18n/index.js';
  import { modelContext } from '#lib/brain/context.js';

  // The chat's composer: the message with its files, or the Brain's key while the selected provider has none, and its
  // tools (attach, the Brain and fast-routing menus, Integrations), then Send, or Stop while a turn runs. The page owns
  // the draft, the key, the files (`files`, a MessageFiles), and every action; it binds the controls it moves the focus
  // to (the message, the file picker, the Integrations button, and Stop).
  let {
    files,
    draft = $bindable(),
    providerKey = $bindable(),
    composerInput = $bindable(),
    attachmentInput = $bindable(),
    integrationsButton = $bindable(),
    stopButton = $bindable(),
    keyRequired,
    brainUnavailable,
    brainSaving,
    brainProvider,
    brainModel,
    placeholder,
    questionOpen,
    composerBusy,
    attachmentsUnavailable,
    menusBusy,
    integrationsOpen,
    integrationsDisabled,
    stopShown,
    stopping,
    sendUnavailable,
    socketReady,
    onsubmit,
    ondrag,
    ondragleave,
    ondrop,
    onretrybrain,
    onkeydown,
    onpaste,
    oncancelfiles,
    onremovefile,
    onchoose,
    onfileschosen,
    ontoggleintegrations,
    onstop,
  } = $props();

  let copy = $derived($t('chatPage'));
  let keyCopy = $derived($t('providerSetup'));
  let attachCopy = $derived($t('attachments'));
  let integrationsCopy = $derived($t('assistantIntegrations'));
</script>

<form
  class="composer"
  class:composer-dropping={files.dragging}
  {onsubmit}
  ondragenter={ondrag}
  ondragover={ondrag}
  {ondragleave}
  {ondrop}
>
  {#if (keyRequired || brainUnavailable) && $modelContext.error}
    <!-- The Brain's own failure sits on the composer it blocks, independent of any chat error. -->
    <Notice class="chat-brain-error" variant="error">
      <strong>{$modelContext.errorCode === 'outcome-unknown' ? $t('shell.outcomeUnknown') : $modelContext.error}</strong>
      {#if brainUnavailable}
        <Button variant="secondary" size="compact" type="button" onclick={onretrybrain} disabled={brainSaving || !$commandsReady}>
          {keyCopy.retry}
        </Button>
      {/if}
    </Notice>
  {/if}
  <div class="composer-input">
    {#if keyRequired}
      <TextField
        id="chat-provider-key"
        label={keyCopy.key}
        visuallyHiddenLabel
        class="composer-field"
        type="password"
        bind:value={providerKey}
        placeholder={$t('providerSetup.keyPlaceholder', {
          provider: brainProvider.title,
          model: brainModel.title,
        })}
        minlength="16"
        maxlength="8192"
        autocomplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore="true"
        spellcheck="false"
        required
        disabled={brainSaving}
        aria-describedby="chat-provider-key-note"
      />
      <p id="chat-provider-key-note" class="sr-only">{keyCopy.keyNote}</p>
    {:else}
      <ComposerAttachments
        items={files.items}
        teamId={files.teamId}
        progress={files.progress}
        reading={files.reading}
        error={files.error}
        oncancel={oncancelfiles}
        onremove={onremovefile}
      />
      {#if files.dragging}
        <p class="composer-drop" aria-hidden="true">{attachCopy.drop}</p>
      {/if}
      <TextAreaField
        id="chat-composer"
        label={copy.send}
        visuallyHiddenLabel
        class="composer-field"
        bind:element={composerInput}
        bind:value={draft}
        rows="2"
        placeholder={questionOpen ? $t('clarify').answerFirst : placeholder}
        disabled={composerBusy || questionOpen}
        {onkeydown}
        {onpaste}
      />
    {/if}
    <Toolbar class="composer-actions">
    {#if !keyRequired}
      <!-- Attaching comes first among the composer's tools; the picker accepts any file Team may keep. -->
      <Button
        class="composer-attach"
        variant="ghost"
        size="icon"
        type="button"
        onclick={onchoose}
        disabled={attachmentsUnavailable || files.items.length >= MAX_ATTACHMENTS}
        aria-label={attachCopy.attach}
        title={attachCopy.attach}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15.5 7.5l-6.8 6.8a1.9 1.9 0 0 0 2.7 2.7l7.1-7.1a3.8 3.8 0 0 0-5.4-5.4l-7.3 7.3a5.7 5.7 0 0 0 8.1 8.1l5.6-5.6"></path>
        </svg>
      </Button>
      <FileInput
        bind:element={attachmentInput}
        id="chat-attachment-picker"
        multiple
        hidden
        onchange={onfileschosen}
      />
    {/if}
    <BrainMenu disabled={menusBusy} />
    <FastRoutingMenu disabled={menusBusy} />
    <Button
      bind:element={integrationsButton}
      class="composer-integrations"
      variant="ghost"
      size="icon"
      type="button"
      onclick={ontoggleintegrations}
      disabled={integrationsDisabled}
      aria-label={integrationsCopy.trigger}
      title={integrationsCopy.trigger}
      aria-expanded={integrationsOpen}
      aria-controls="assistant-integrations-drawer"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v2.2a2.8 2.8 0 0 1-2.8 2.8H8"></path>
      </svg>
    </Button>
    {#if stopShown}
      <!-- While a turn runs, Send becomes Stop in place; once the turn ends it is Send again. -->
      <Button
        bind:element={stopButton}
        class="composer-send composer-stop"
        type="button"
        variant="ghost"
        onclick={onstop}
        disabled={stopping}
        title={copy.stop}
      >
        <span class="sr-only">{copy.stop}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"></path></svg>
      </Button>
    {:else if keyRequired}
      <Button type="submit" disabled={brainSaving || !$commandsReady || providerKey.trim().length < 16}>
        {brainSaving ? keyCopy.validating : keyCopy.saveKey}
      </Button>
    {:else}
      <Button
        class="composer-send"
        type="submit"
        variant="ghost"
        disabled={sendUnavailable || questionOpen || !draft.trim() || files.pending}
        title={socketReady ? copy.send : copy.connecting}
      >
        <span class="sr-only">{socketReady ? copy.send : copy.connecting}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.5V4.5M5.5 11 12 4.5l6.5 6.5"></path></svg>
      </Button>
    {/if}
    </Toolbar>
  </div>
</form>

<style>
  .composer :global(.chat-brain-error) {
    display: grid;
    justify-items: start;
    gap: var(--gap-item);
    font-size: 0.72rem;
  }

  .composer :global(.chat-brain-error strong) {
    font-weight: 600;
  }

  .composer {
    display: grid;
    width: min(
      calc(100% - (2 * var(--chat-rail-gutter))),
      var(--chat-rail-width)
    );
    grid-template-columns: minmax(0, 1fr);
    grid-row: 3;
    align-items: end;
    justify-self: center;
    gap: var(--gap-item);
    padding: var(--gap-item) 0;
    background: var(--surface-1);
  }

  :global(.empty-conversation) .composer {
    grid-row: 1;
    align-self: center;
  }

  /* The composer is one quiet chamfered surface: the message, then a hairline-free row of bare tool icons and a
     compact send key. Focus lights the frame and a cyan corner tick; nothing else competes with the text. */
  .composer-input {
    position: relative;
    display: grid;
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
    border: 1px solid color-mix(in srgb, var(--shimpz-color-text) 10%, transparent);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 2%, var(--shimpz-color-bg));
    clip-path: var(--shimpz-control-shape);
    transition: border-color var(--shimpz-duration-fast) var(--shimpz-ease), background var(--shimpz-duration-fast) var(--shimpz-ease);
  }

  .composer-input::before {
    position: absolute;
    inset-block-start: -1px;
    inset-inline-start: -1px;
    width: 1.1rem;
    height: 1px;
    background: var(--shimpz-color-cyan);
    opacity: 0.45;
    content: "";
    transition: opacity var(--shimpz-duration-fast) var(--shimpz-ease), width var(--shimpz-duration-fast) var(--shimpz-ease);
  }

  .composer-input:focus-within {
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 4%, var(--shimpz-color-bg));
  }

  .composer-input:focus-within::before { width: 2.5rem; opacity: 1; }

  /* Files dragged over the composer light its frame and name what dropping does. */
  .composer-dropping .composer-input {
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 45%, transparent);
    border-style: dashed;
  }

  .composer-drop {
    margin: 0;
    padding: var(--gap-item) var(--gap-group) 0;
    color: var(--shimpz-color-text-muted);
    font: 400 0.75rem/1.4 var(--shimpz-font-mono);
  }

  .composer-input :global(.composer-field) { gap: 0; }

  .composer-input :global(.composer-field textarea),
  .composer-input :global(.composer-field input) {
    width: 100%;
    height: auto;
    min-height: 3.25rem;
    max-height: 12rem;
    field-sizing: content;
    resize: none;
    padding: var(--gap-group) var(--gap-group) var(--gap-inside);
    color: var(--shimpz-color-text);
    font: 400 0.95rem/1.5 var(--shimpz-font-sans);
    background: transparent;
    border: 0;
    clip-path: none;
    overflow-y: auto;
  }

  .composer-input :global(.composer-field textarea::placeholder),
  .composer-input :global(.composer-field input::placeholder) {
    color: var(--shimpz-color-text-dim);
    font-family: var(--shimpz-font-mono);
    font-size: 0.82rem;
    letter-spacing: 0.02em;
  }

  /* The frame carries focus; the field's own ring would draw a box inside the box. */
  .composer-input :global(.composer-field textarea:focus),
  .composer-input :global(.composer-field input:focus) {
    border: 0;
    outline: none;
    box-shadow: none;
  }

  :global(.composer-actions) {
    display: flex;
    align-items: center;
    gap: var(--gap-inside);
    padding: var(--gap-inside) var(--gap-item) var(--gap-item);
  }

  :global(.composer-actions .composer-integrations) {
    margin-inline-end: auto;
  }

  /* Tool controls are bare icons: no frame, only their color reacts. */
  .composer-input :global(.shimpz-button.composer-attach),
  .composer-input :global(.shimpz-button.composer-attach:hover:not(:disabled)),
  .composer-input :global(.shimpz-button.composer-integrations),
  .composer-input :global(.shimpz-button.composer-integrations:hover:not(:disabled)) {
    color: var(--shimpz-color-text-dim);
    border-color: transparent;
    background: transparent;
    clip-path: none;
    box-shadow: none;
  }

  .composer-input :global(.shimpz-button.composer-attach:hover:not(:disabled)),
  .composer-input :global(.shimpz-button.composer-integrations:hover:not(:disabled)),
  .composer-input :global(.shimpz-button.composer-integrations[aria-expanded="true"]) {
    color: var(--shimpz-color-cyan);
  }

  .composer :global(.shimpz-button) {
    height: 2.25rem;
    min-height: 0;
  }

  .composer-input :global(.brain-trigger),
  .composer-input :global(.composer-attach),
  .composer-input :global(.composer-integrations) {
    width: 2.25rem;
    height: 2.25rem;
  }

  /* Send is a compact chamfered key: a dim outline at rest, cyan once there is something to send. */
  .composer-input :global(.shimpz-button.composer-send) {
    width: 2.25rem;
    padding: 0;
    color: var(--shimpz-color-cyan);
    background: color-mix(in srgb, var(--shimpz-color-cyan) 10%, transparent);
    border-color: color-mix(in srgb, var(--shimpz-color-cyan) 55%, transparent);
  }

  .composer-input :global(.shimpz-button.composer-send:hover:not(:disabled)) {
    color: var(--shimpz-color-bg);
    background: var(--shimpz-color-cyan);
    border-color: var(--shimpz-color-cyan);
  }

  .composer-input :global(.shimpz-button.composer-send:disabled) {
    color: var(--shimpz-color-text-dim);
    background: transparent;
    border-color: var(--shimpz-color-border);
    filter: none;
    opacity: 1;
  }

  /* Stop takes Send's place while a turn runs: the same key, filled red with an X. */
  .composer-input :global(.shimpz-button.composer-send.composer-stop),
  .composer-input :global(.shimpz-button.composer-send.composer-stop:hover:not(:disabled)) {
    color: var(--shimpz-color-bg);
    background: var(--shimpz-color-danger);
    border-color: var(--shimpz-color-danger);
  }

  .composer-input :global(.shimpz-button.composer-send.composer-stop:disabled) {
    color: var(--shimpz-color-bg);
    background: color-mix(in srgb, var(--shimpz-color-danger) 45%, transparent);
    border-color: color-mix(in srgb, var(--shimpz-color-danger) 45%, transparent);
  }

  :global(.composer-actions .shimpz-button svg) {
    width: 1.05rem;
    height: 1.05rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  .composer-input :global(.shimpz-button.composer-send:hover:not(:disabled) svg) { filter: none; }

  @media (prefers-reduced-motion: reduce) {
    .composer-input, .composer-input::before { transition: none; }
    .composer-input :global(svg) { animation: none !important; }
  }

  @media (max-width: 820px) {
    :global(.empty-conversation) .composer { align-self: end; }
  }

  @media (forced-colors: active) {
    .composer-input { border-color: CanvasText; clip-path: none; }
  }

  @media (max-width: 640px) {
    .composer :global(.shimpz-button) { padding-inline: var(--gap-item); }
  }
</style>
