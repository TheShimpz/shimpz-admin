<script>
  import {
    Button,
    Card,
    CheckboxField,
    Notice,
    PromptDialog,
    RadioField,
    SelectField,
    TextAreaField,
    TextField,
  } from '@shimpz/frontend';
  import { t } from '$lib/i18n.js';

  let {
    open = $bindable(false),
    challenge,
    working = false,
    onrespond = () => {},
  } = $props();

  let challengeId = $state('');
  let textValue = $state('');
  let singleValue = $state('');
  let selectedValues = $state([]);
  let validationError = $state('');

  let request = $derived(challenge?.request);
  let kind = $derived(request?.kind ?? '');
  let isAuth = $derived(kind.startsWith('auth:'));
  let isInput = $derived(kind.startsWith('input:'));
  let copy = $derived($t('humanRequest'));
  let kicker = $derived(isAuth ? copy.authKicker : isInput ? copy.inputKicker : copy.approvalKicker);
  let primaryLabel = $derived(
    kind === 'approval' ? copy.approve : isAuth ? (kind === 'auth:phishing-resistant' ? copy.usePasskey : copy.authorize) : copy.submit,
  );

  $effect(() => {
    const nextId = challenge?.challenge_id ?? '';
    if (nextId === challengeId) return;
    challengeId = nextId;
    textValue = '';
    singleValue = '';
    selectedValues = [];
    validationError = '';
  });

  function deny(event) {
    event?.preventDefault();
    if (!working && challenge) onrespond({ decision: 'deny' });
  }

  function toggle(value, checked) {
    selectedValues = checked
      ? [...selectedValues, value]
      : selectedValues.filter((item) => item !== value);
  }

  function responseValue() {
    if (kind === 'approval') return true;
    if (kind === 'input:select' || kind === 'input:choice') return singleValue;
    if (kind === 'input:choices') return selectedValues;
    if (kind === 'auth:phishing-resistant') return 'passkey';
    return textValue;
  }

  function valid(value) {
    if (kind === 'approval') return value === true;
    if (kind === 'input:select' || kind === 'input:choice') {
      return value !== '' || request.required === false;
    }
    if (kind === 'input:choices') {
      return value.length >= request.min_selections && value.length <= request.max_selections;
    }
    if (kind === 'auth:phishing-resistant') return true;
    if (isAuth) return typeof value === 'string' && value.length > 0;
    return (
      typeof value === 'string' &&
      value.length >= request.min_length &&
      value.length <= request.max_length &&
      (request.required === false || value.length > 0)
    );
  }

  function submit(event) {
    event.preventDefault();
    if (working || !challenge) return;
    const value = responseValue();
    if (!valid(value)) {
      validationError = copy.invalid;
      return;
    }
    validationError = '';
    onrespond({ decision: 'submit', value });
  }
</script>

{#if challenge && request}
  <PromptDialog
    bind:open
    {kicker}
    title={request.title}
    titleId="human-request-title"
    lead={request.description}
    size="md"
    oncancel={deny}
    onsubmit={submit}
  >
        <p class="paused">{copy.paused} <span>{$t('humanRequest.expires', { seconds: String(challenge.expires_in) })}</span></p>
        <Card class="request-origin" padding="compact">
          <div><span>{copy.assistant}</span><strong>{challenge.assistant.name}</strong><code>{challenge.assistant.id}</code></div>
          <div><span>{copy.power}</span><strong>{challenge.power.summary}</strong><code>{challenge.power.id}</code></div>
        </Card>

        {#if kind === 'input:text' || kind === 'input:password' || kind === 'input:phone'}
          {#if kind === 'input:password'}
            <Notice variant="warning">{$t('humanRequest.thirdPartySecret', { assistant: challenge.assistant.name })}</Notice>
          {/if}
          <TextField
            id="human-request-value"
            label={`${request.label} · ${request.required ? copy.required : copy.optional}`}
            type={kind === 'input:password' ? 'password' : kind === 'input:phone' ? 'tel' : 'text'}
            inputmode={kind === 'input:phone' ? 'tel' : undefined}
            autocomplete={kind === 'input:phone' ? 'tel' : 'off'}
            spellcheck={kind === 'input:password' ? 'false' : undefined}
            placeholder={request.placeholder ?? undefined}
            minlength={request.min_length}
            maxlength={request.max_length}
            required={request.required}
            bind:value={textValue}
          />
        {:else if kind === 'input:textarea'}
          <TextAreaField
            id="human-request-value"
            label={`${request.label} · ${request.required ? copy.required : copy.optional}`}
            placeholder={request.placeholder ?? undefined}
            minlength={request.min_length}
            maxlength={request.max_length}
            required={request.required}
            rows="6"
            bind:value={textValue}
          />
        {:else if kind === 'input:select'}
          <SelectField
            id="human-request-value"
            label={`${request.label} · ${request.required ? copy.required : copy.optional}`}
            placeholder={copy.chooseOption}
            options={request.options}
            required={request.required}
            bind:value={singleValue}
          />
        {:else if kind === 'input:choice'}
          <fieldset>
            <legend>{request.label} · {request.required ? copy.required : copy.optional}</legend>
            {#each request.options as option (option.value)}
              <RadioField
                id={`human-request-${option.value}`}
                name="human-request-choice"
                optionValue={option.value}
                label={option.label}
                description={option.description ?? undefined}
                bind:value={singleValue}
              />
            {/each}
          </fieldset>
        {:else if kind === 'input:choices'}
          <fieldset>
            <legend>{request.label} · {request.required ? copy.required : copy.optional}</legend>
            <p class="field-hint">{$t('humanRequest.selectionHint', { minimum: String(request.min_selections), maximum: String(request.max_selections) })}</p>
            {#each request.options as option (option.value)}
              <CheckboxField
                id={`human-request-${option.value}`}
                label={option.label}
                hint={option.description ?? undefined}
                checked={selectedValues.includes(option.value)}
                onchange={(event) => toggle(option.value, event.currentTarget.checked)}
              />
            {/each}
          </fieldset>
        {:else if kind === 'auth:reauth'}
          <Notice variant="warning">{copy.reauthHint}</Notice>
          <TextField
            id="human-request-auth"
            label={copy.authorize}
            type="password"
            autocomplete="current-password"
            required
            maxlength="4096"
            bind:value={textValue}
          />
        {:else if kind === 'auth:second-factor'}
          <Notice variant="warning">{copy.secondFactorHint}</Notice>
          <TextField
            id="human-request-auth"
            label={copy.secondFactorLabel}
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder={copy.secondFactorPlaceholder}
            required
            maxlength="4096"
            bind:value={textValue}
          />
        {:else if kind === 'auth:phishing-resistant'}
          <Notice variant="warning">{copy.passkeyHint}</Notice>
        {/if}

        {#if validationError}<Notice variant="error">{validationError}</Notice>{/if}
    {#snippet footer()}
      <Button type="button" variant="secondary" disabled={working} onclick={deny}>{copy.cancel}</Button>
      <Button type="submit" disabled={working}>{primaryLabel}</Button>
    {/snippet}
  </PromptDialog>
{/if}

<style>
  .paused { margin: 0; color: var(--text-dim); font-size: 0.72rem; line-height: 1.5; }
  .paused span { color: var(--accent); font-family: var(--font-mono); }
  :global(.request-origin > [data-slot="card-content"]) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--shimpz-space-4); }
  :global(.request-origin [data-slot="card-content"] > div) { display: grid; min-width: 0; gap: 0.18rem; }
  :global(.request-origin span) { color: var(--text-faint); font: 600 0.58rem/1.2 var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; }
  :global(.request-origin strong) { overflow: hidden; font-size: 0.78rem; line-height: 1.4; text-overflow: ellipsis; }
  :global(.request-origin code) { overflow: hidden; color: var(--accent); font-size: 0.6rem; text-overflow: ellipsis; }
  fieldset { display: grid; gap: var(--shimpz-space-2); margin: 0; border: 0; padding: 0; }
  legend { margin-bottom: var(--shimpz-space-1); padding: 0; color: var(--text); font: 600 0.7rem/1.2 var(--font-mono); letter-spacing: 0.07em; text-transform: uppercase; }
  .field-hint { margin: 0 0 var(--shimpz-space-1); color: var(--text-dim); font-size: 0.72rem; }
  @media (max-width: 520px) { :global(.request-origin > [data-slot="card-content"]) { grid-template-columns: 1fr; } }
</style>
