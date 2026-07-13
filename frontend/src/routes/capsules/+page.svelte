<script>
  import { onMount } from "svelte";

  let phase = $state("checking"); // checking | needauth | ready
  let capsules = $state([]);
  let name = $state("");
  let busy = $state(false);
  let error = $state("");

  async function refresh() {
    try {
      const r = await fetch("/api/capsules");
      if (r.ok) {
        capsules = (await r.json()).capsules ?? [];
        error = "";
      } else {
        error = (await r.json().catch(() => ({}))).detail ?? "could not reach the capsule-driver";
      }
    } catch (e) {
      error = String(e);
    }
  }

  async function load() {
    try {
      const s = await (await fetch("/api/session")).json();
      if (!s.authenticated) {
        phase = "needauth";
        return;
      }
    } catch {
      phase = "needauth";
      return;
    }
    await refresh();
    phase = "ready";
  }

  async function create() {
    if (!name.trim() || busy) return;
    busy = true;
    error = "";
    try {
      const r = await fetch("/api/capsules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (r.ok) {
        name = "";
        await refresh();
      } else {
        error = (await r.json().catch(() => ({}))).detail ?? "create failed";
      }
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function destroy(id) {
    if (!confirm(`Destroy Capsule "${id}"? This permanently wipes its data, database and network.`)) return;
    busy = true;
    error = "";
    try {
      const r = await fetch(`/api/capsules/${id}`, { method: "DELETE" });
      if (r.ok) await refresh();
      else error = (await r.json().catch(() => ({}))).detail ?? "destroy failed";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<svelte:head><title>Capsules — Shimpz admin</title></svelte:head>

<main>
  <header>
    <a href="/" class="back">← Shimpz admin</a>
    <h1>Capsules</h1>
    <p class="lead">
      A Capsule is a sealed, isolated environment — its own agent, database, and network, sharing the
      Space's platform plane. Create one from scratch, or tear one down.
    </p>
  </header>

  {#if phase === "checking"}
    <p class="muted">Loading…</p>
  {:else if phase === "needauth"}
    <div class="card">
      <p>You need to be signed in. <a href="/">Open the admin panel</a> and log in first.</p>
    </div>
  {:else}
    <div class="card create">
      <label for="cap-name">New Capsule</label>
      <div class="row">
        <input
          id="cap-name"
          type="text"
          bind:value={name}
          placeholder="e.g. my-workspace"
          onkeydown={(e) => e.key === "Enter" && create()}
        />
        <button onclick={create} disabled={busy || !name.trim()}>Create</button>
      </div>
    </div>

    {#if error}<p class="error">{error}</p>{/if}

    <div class="card">
      <div class="list-head"><span>{capsules.length} capsule{capsules.length === 1 ? "" : "s"}</span></div>
      {#if capsules.length === 0}
        <p class="muted">No capsules yet. Create one above.</p>
      {:else}
        <ul>
          {#each capsules as c (c.id)}
            <li>
              <span class="dot" class:running={c.status === "running"}></span>
              <span class="cap-name">{c.name || c.id}</span>
              <span class="cap-id">{c.id}</span>
              <span class="cap-status">{c.status}</span>
              <button class="danger" onclick={() => destroy(c.id)} disabled={busy}>Destroy</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
    color: #e8eaed;
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      "Segoe UI",
      sans-serif;
  }
  .back {
    color: #8ab4f8;
    text-decoration: none;
    font-size: 0.9rem;
  }
  h1 {
    margin: 0.6rem 0 0.4rem;
    font-size: 2rem;
    letter-spacing: -0.02em;
  }
  .lead {
    color: #9aa0a6;
    line-height: 1.55;
    max-width: 60ch;
    margin: 0 0 1.75rem;
  }
  .muted {
    color: #9aa0a6;
  }
  .card {
    background: #1b1c1f;
    border: 1px solid #2c2e33;
    border-radius: 12px;
    padding: 1.1rem 1.25rem;
    margin-bottom: 1rem;
  }
  .create label {
    display: block;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9aa0a6;
    margin-bottom: 0.6rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
  }
  input {
    flex: 1;
    background: #0f1012;
    border: 1px solid #2c2e33;
    border-radius: 8px;
    padding: 0.7rem 0.9rem;
    color: #e8eaed;
    font-size: 1rem;
    outline: none;
  }
  input:focus {
    border-color: #8ab4f8;
  }
  button {
    background: #8ab4f8;
    color: #0f1012;
    border: 0;
    border-radius: 8px;
    padding: 0 1.2rem;
    font-weight: 600;
    cursor: pointer;
    font-size: 0.95rem;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.danger {
    background: transparent;
    color: #f28b82;
    border: 1px solid #5a2d2a;
    padding: 0.35rem 0.8rem;
  }
  .error {
    color: #f28b82;
    margin: 0 0 1rem;
  }
  .list-head {
    font-size: 0.85rem;
    color: #9aa0a6;
    margin-bottom: 0.75rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.2rem;
    border-top: 1px solid #2c2e33;
  }
  li:first-child {
    border-top: 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #5f6368;
    flex: none;
  }
  .dot.running {
    background: #81c995;
  }
  .cap-name {
    font-weight: 600;
  }
  .cap-id {
    color: #9aa0a6;
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
  }
  .cap-status {
    margin-left: auto;
    color: #9aa0a6;
    font-size: 0.85rem;
  }
</style>
