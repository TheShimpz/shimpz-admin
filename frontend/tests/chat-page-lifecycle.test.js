import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/routes/chat/+page.svelte', import.meta.url), 'utf8');

test('consumes the shared Team context without duplicating the persistent shell or sidebar', () => {
  assert.match(source, /import \{ teamContext \} from '\$lib\/teamContext\.js';/);
  assert.match(source, /import \{ modelContext \} from '\$lib\/modelContext\.js';/);
  assert.match(source, /import ProviderSetupGate from '\$lib\/ProviderSetupGate\.svelte';/);
  assert.doesNotMatch(source, /loadTeamContext|refreshTeams|selectTeam/);
  assert.match(source, /\$teamContext\.selectedTeamId/);
  assert.match(source, /\$teamContext\.teams/);
  assert.match(source, /\$teamContext\.selectedFileIds/);

  assert.doesNotMatch(source, /AdminShell|LocaleMenu|AssistantIcon/);
  assert.doesNotMatch(source, /listAssistantCatalog|listInstalledAssistants|listCapsuleFiles|safeApiError/);
  assert.doesNotMatch(source, /\/api\/session|\/api\/capsules['"`]/);
  assert.doesNotMatch(source, /<aside|class="assistants"|class="files"|<select/);
});

test('derives loading and bounded context diagnostics without owning the initial load', () => {
  assert.match(
    source,
    /let contextLoading = \$derived\(\s+\$teamContext\.phase === 'idle' \|\| \$teamContext\.phase === 'loading',/,
  );
  assert.match(source, /let contextFailed = \$derived\(\$teamContext\.phase === 'error'\);/);
  assert.match(source, /typeof \$teamContext\.error === 'string'/);
  assert.match(source, /\$teamContext\.error\.length <= 300/);
  assert.match(source, /contextFailed \? copy\.loadFailed : ''/);
  assert.match(source, /error \? errorDetail : contextErrorDetail/);
  assert.doesNotMatch(source, /new URL\(location\.href\)|searchParams\.get\('capsule'\)/);
});

test('changes Team by closing stale transport and clearing route-scoped conversation state', () => {
  assert.match(
    source,
    /\$effect\(\(\) => \{\s+const nextTeamId = chatTeamId;\s+if \(!mounted \|\| nextTeamId === socketTeamId\) return;\s+activateTeam\(nextTeamId\);/,
  );
  assert.match(
    source,
    /function activateTeam\(nextTeamId\) \{\s+closeSocket\(\);\s+socketTeamId = nextTeamId;[\s\S]*?busy = false;\s+stopping = false;\s+draft = '';\s+turns = \[\];\s+clearError\(\);\s+if \(nextTeamId\) connectSocket\(nextTeamId\);/,
  );
  assert.match(source, /if \(socket !== active \|\| chatTeamId !== expectedTeamId\) return;/);
  assert.match(source, /current\?\.close\(1000, 'Team changed'\)/);
  assert.match(
    source,
    /onMount\(\(\) => \{\s+mounted = true;\s+const initialTeamId = chatTeamId;\s+if \(initialTeamId !== socketTeamId\) activateTeam\(initialTeamId\);/,
  );
});

test('keeps WebSocket and composer unavailable until the selected Team model is verified', () => {
  assert.match(source, /\$modelContext\.ready && \$modelContext\.teamId === selectedTeamId \? selectedTeamId : ''/);
  assert.match(source, /if \(!mounted \|\| !expectedTeamId \|\| chatTeamId !== expectedTeamId\) return;/);
  assert.match(source, /if \(busy \|\| !teamId \|\| chatTeamId !== teamId/);
  assert.match(source, /\{#if chatTeamId\}[\s\S]*<form class="composer"[\s\S]*\{:else\}[\s\S]*<ProviderSetupGate \/>/);
});

test('keeps versioned WebSocket send, stop, reconnect and selected file contracts route-scoped', () => {
  assert.match(source, /new WebSocket\(chatSocketUrl\(location, expectedTeamId\), CHAT_WS_PROTOCOL\)/);
  assert.match(source, /active\.protocol !== CHAT_WS_PROTOCOL/);
  assert.match(source, /scheduleReconnect\(expectedTeamId\)/);
  assert.match(
    source,
    /createChatFrame\(teamId, \{\s+message,\s+files: \$teamContext\.selectedFileIds,\s+\}\)/,
  );
  assert.match(source, /createStopFrame\(teamId\)/);
  assert.match(source, /parseChatTerminalEvent\(JSON\.parse\(event\.data\), expectedTeam\.name\)/);
});

test('submits plain Enter while preserving modified newlines and IME composition', () => {
  assert.match(
    source,
    /function handleComposerKeydown\(event\) \{[\s\S]*event\.key !== 'Enter'[\s\S]*event\.ctrlKey[\s\S]*event\.metaKey[\s\S]*event\.shiftKey[\s\S]*event\.altKey[\s\S]*event\.isComposing[\s\S]*event\.preventDefault\(\);[\s\S]*event\.currentTarget\.form\?\.requestSubmit\(\);/,
  );
  assert.match(source, /<textarea[\s\S]*onkeydown=\{handleComposerKeydown\}[\s\S]*><\/textarea>/);
  assert.doesNotMatch(source, /onkeydown=\{send\}/);
});

test('fills the main column while keeping turns scrollable and the composer visible', () => {
  assert.match(source, /<div class="chat-route">/);
  assert.match(source, /<header class="team-header">/);
  assert.match(source, /<div class="turns" aria-live="polite">/);
  assert.match(source, /<form class="composer" onsubmit=\{send\}>/);
  assert.match(source, /\.chat-route \{[\s\S]*?height: 100%;[\s\S]*?min-height: 0;/);
  assert.match(source, /grid-template-rows: minmax\(0, 1fr\);[\s\S]*?overflow: hidden;/);
  assert.match(source, /\.conversation \{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(
    source,
    /\.conversation \{[\s\S]*?border: 0;[\s\S]*?border-inline-end: 1px solid var\(--admin-divider\);[\s\S]*?border-bottom: 1px solid var\(--admin-divider\);/,
  );
  assert.match(source, /\.team-header \{[\s\S]*?border-bottom: 1px solid var\(--admin-divider\);/);
  assert.match(source, /\.turns \{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/);
  assert.match(source, /textarea \{[\s\S]*?height: 3\.2rem;[\s\S]*?resize: none;[\s\S]*?overflow-y: auto;/);
  assert.doesNotMatch(source, /\.composer \{[^}]*border-top:/s);
  assert.match(source, /\.composer button \{\s*height: 3\.2rem;\s*min-height: 0;/);
  assert.match(
    source,
    /\.empty-state \{[\s\S]*?border: 0;[\s\S]*?border-inline-end: 1px solid var\(--admin-divider\);[\s\S]*?border-bottom: 1px solid var\(--admin-divider\);/,
  );
  assert.match(source, /\.error \{[\s\S]*?max-height: min\(8rem, 24dvh\);[\s\S]*?overflow-y: auto;/);
  assert.doesNotMatch(source, /class="heading"|max-height: 32rem/);
});

test('keeps friendly i18n and sanitized technical diagnostics separate', () => {
  assert.doesNotMatch(source, /error\s*=\s*terminal\.detail/);
  assert.match(source, /friendlyChatError\(terminal\.status\)/);
  assert.match(source, /`HTTP \$\{terminal\.status\} · \$\{terminal\.detail\}`/);
  assert.match(source, /<div class="error" role="alert">/);
  assert.match(source, /\{copy\.technicalDetail\}: \{visibleErrorDetail\}/);
  assert.doesNotMatch(source, /\{@html[^}]*?(?:error|detail)/i);
});
