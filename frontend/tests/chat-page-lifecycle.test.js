import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/routes/chat/+page.svelte', import.meta.url), 'utf8');
const appStyles = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const thinkingSource = readFileSync(new URL('../src/lib/ShimpzThinking.svelte', import.meta.url), 'utf8');
const drawerSource = readFileSync(new URL('../src/lib/AssistantHelpDrawer.svelte', import.meta.url), 'utf8');
const markdownSource = readFileSync(new URL('../src/lib/HelpMarkdown.svelte', import.meta.url), 'utf8');
const inlineSource = readFileSync(new URL('../src/lib/HelpInline.svelte', import.meta.url), 'utf8');

test('consumes the shared Team context without duplicating the persistent shell or sidebar', () => {
  assert.match(source, /import \{ teamContext \} from '\$lib\/teamContext\.js';/);
  assert.match(source, /import \{ modelContext \} from '\$lib\/modelContext\.js';/);
  assert.match(source, /import ProviderSetupGate from '\$lib\/ProviderSetupGate\.svelte';/);
  assert.doesNotMatch(source, /loadTeamContext|refreshTeams|selectTeam/);
  assert.match(source, /\$teamContext\.selectedTeamId/);
  assert.match(source, /\$teamContext\.teams/);
  assert.match(source, /\$teamContext\.selectedFileIds/);
  assert.match(source, /\$teamContext\.selectedAssistantIds/);

  assert.doesNotMatch(source, /AdminShell|LocaleMenu|AssistantIcon/);
  assert.doesNotMatch(source, /listAssistantCatalog|listInstalledAssistants|listTeamFiles|safeApiError/);
  assert.doesNotMatch(source, /\/api\/session|\/api\/teams['"`]/);
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
  assert.doesNotMatch(source, /new URL\(location\.href\)|searchParams\.get\('team'\)/);
});

test('changes Team by closing stale transport and clearing route-scoped conversation state', () => {
  assert.match(
    source,
    /\$effect\(\(\) => \{\s+const nextTeamId = chatTeamId;\s+if \(!mounted \|\| nextTeamId === socketTeamId\) return;\s+activateTeam\(nextTeamId\);/,
  );
  assert.match(
    source,
    /function activateTeam\(nextTeamId\) \{\s+closeSocket\(\);\s+socketTeamId = nextTeamId;[\s\S]*?busy = false;\s+stopping = false;\s+draft = '';\s+turns = \[\];\s+scrollRequest \+= 1;\s+helpOpen = false;\s+secretsOpen = false;\s+secretsDialogOpen = false;\s+secretChallenge = undefined;\s+approvalDialogOpen = false;\s+approvalChallenge = undefined;\s+secretInventory = \[\];\s+secretInventoryReady = false;\s+clearError\(\);\s+if \(nextTeamId\) connectSocket\(nextTeamId\);/,
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
    /createChatFrame\(teamId, \{\s+message,\s+files: \$teamContext\.selectedFileIds,\s+assistant_ids: \$teamContext\.selectedAssistantIds,\s+\}\)/,
  );
  assert.match(source, /createStopFrame\(teamId\)/);
  assert.match(
    source,
    /parseChatEvent\(\s*JSON\.parse\(event\.data\),\s*expectedTeam\.id,\s*expectedTeam\.name,\s*\)/,
  );
  assert.match(source, /author: incoming\.team_name/);
});

test('submits plain Enter while preserving modified newlines and IME composition', () => {
  assert.match(
    source,
    /function handleComposerKeydown\(event\) \{[\s\S]*event\.key !== 'Enter'[\s\S]*event\.ctrlKey[\s\S]*event\.metaKey[\s\S]*event\.shiftKey[\s\S]*event\.altKey[\s\S]*event\.isComposing[\s\S]*event\.preventDefault\(\);[\s\S]*event\.currentTarget\.form\?\.requestSubmit\(\);/,
  );
  assert.match(source, /<textarea[\s\S]*onkeydown=\{handleComposerKeydown\}[\s\S]*><\/textarea>/);
  assert.doesNotMatch(source, /onkeydown=\{send\}/);
});

test('focuses the ready chat composer without drawing field outlines', () => {
  assert.match(source, /let mounted = \$state\(false\);/);
  assert.match(source, /let composerInput = \$state\(\);/);
  assert.match(source, /async function focusComposer\(\)[\s\S]*await tick\(\);[\s\S]*composerInput\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(source, /mounted && chatTeamId && !busy && !helpOpen && !secretsOpen[\s\S]*void focusComposer\(\);/);
  assert.match(source, /<textarea[\s\S]*bind:this=\{composerInput\}[\s\S]*bind:value=\{draft\}/);
  assert.match(appStyles, /input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible \{\s*outline: 0;/);
});

test('reveals each sent and received turn without forcing motion-sensitive users', () => {
  assert.match(source, /import \{ onMount, tick \} from 'svelte';/);
  assert.match(source, /<div class="turns" bind:this=\{turnsViewport\} aria-live="polite">/);
  assert.match(
    source,
    /async function revealLatestTurn\(\)[\s\S]*await tick\(\);[\s\S]*querySelector\('article:last-of-type'\)[\s\S]*matchMedia\('\(prefers-reduced-motion: reduce\)'\)[\s\S]*turnsViewport\.scrollTo\(\{[\s\S]*latest\.offsetTop - 16[\s\S]*behavior: reducedMotion \? 'auto' : 'smooth'/,
  );
  assert.match(
    source,
    /turns = \[\.\.\.turns, \{ role: 'user', text: message \}\];\s+void revealLatestTurn\(\);/,
  );
  assert.match(
    source,
    /turns = \[\.\.\.turns, \{ role: 'assistant', text: incoming\.reply, author: incoming\.team_name \}\];\s+void revealLatestTurn\(\);/,
  );
});

test('fills the main column while keeping turns scrollable and the composer visible', () => {
  assert.match(source, /<div class="chat-route">/);
  assert.doesNotMatch(source, /team-header|conversation-empty/);
  assert.match(source, /class:empty-conversation=\{turns\.length === 0\}/);
  assert.match(source, /<div class="turns" bind:this=\{turnsViewport\} aria-live="polite">/);
  assert.match(source, /<form class="composer" onsubmit=\{send\}>/);
  assert.match(source, /\.chat-route \{[\s\S]*?height: 100%;[\s\S]*?min-height: 0;/);
  assert.match(source, /grid-template-rows: minmax\(0, 1fr\);[\s\S]*?overflow: hidden;/);
  assert.match(source, /\.conversation \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\) auto auto;/);
  assert.match(
    source,
    /\.conversation \{[\s\S]*?border: 0;[\s\S]*?border-inline-end: 1px solid var\(--admin-divider\);[\s\S]*?border-bottom: 1px solid var\(--admin-divider\);/,
  );
  assert.match(source, /\.turns \{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/);
  assert.match(source, /\.empty-conversation \.turns \{\s*display: none;/);
  assert.match(source, /--chat-rail-gutter: 0\.8rem;[\s\S]*?--chat-rail-width: 52rem;/);
  assert.match(
    source,
    /\.turns \{[\s\S]*?padding-inline: max\([\s\S]*?var\(--chat-rail-gutter\),[\s\S]*?calc\(\(100% - var\(--chat-rail-width\)\) \/ 2\)[\s\S]*?\);/,
  );
  assert.match(
    source,
    /\.composer \{[\s\S]*?width: min\([\s\S]*?var\(--chat-rail-width\)[\s\S]*?\);[\s\S]*?grid-row: 3;/,
  );
  assert.match(source, /\.empty-conversation \.composer \{\s*grid-row: 1;\s*align-self: center;/);
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

test('uses the full composer rail for Team replies while keeping user turns bounded', () => {
  assert.match(
    source,
    /article\.assistant \{\s*align-self: stretch;\s*width: 100%;\s*max-width: none;/,
  );
  assert.match(
    source,
    /article\.user \{\s*align-self: flex-end;\s*width: fit-content;\s*max-width: min\(80%, 46rem\);/,
  );
  assert.match(source, /article \{[\s\S]*?background: transparent;/);
  assert.match(source, /article\.assistant::before \{[\s\S]*?background: var\(--accent-alt\);/);
  assert.match(source, /article\.user::before \{[\s\S]*?background: var\(--accent\);/);
  assert.match(source, /@media \(max-width: 640px\) \{\s*article\.user \{ max-width: 92%; \}/);
  assert.doesNotMatch(source, /@media \(max-width: 640px\) \{\s*article \{ max-width:/);
});

test('shows the accessible Shimpz motion mark only while the Team is working', () => {
  assert.match(source, /import ShimpzThinking from '\$lib\/ShimpzThinking\.svelte';/);
  assert.match(source, /\{#if busy\}<ShimpzThinking label=\{thinking\} \/>\{\/if\}/);
  assert.match(thinkingSource, /role="status"/);
  assert.match(thinkingSource, /shimpz-thinking\.svg/);
  assert.match(thinkingSource, /@media \(prefers-reduced-motion: reduce\)/);
});

test('renders only Assistant replies through the closed Markdown component', () => {
  assert.match(source, /import HelpMarkdown from '\$lib\/HelpMarkdown\.svelte';/);
  assert.match(
    source,
    /\{#if turn\.role === 'assistant'\}[\s\S]*?<HelpMarkdown markdown=\{turn\.text\} variant="chat" \/>[\s\S]*?\{:else\}[\s\S]*?<p>\{turn\.text\}<\/p>/,
  );
  assert.doesNotMatch(source, /\{@html/);
});

test('keeps friendly i18n and sanitized technical diagnostics separate', () => {
  assert.doesNotMatch(source, /error\s*=\s*incoming\.detail/);
  assert.match(source, /friendlyChatError\(incoming\.status\)/);
  assert.match(source, /`HTTP \$\{incoming\.status\} · \$\{incoming\.detail\}`/);
  assert.match(source, /<div class="error" role="alert">/);
  assert.match(source, /\{copy\.technicalDetail\}: \{visibleErrorDetail\}/);
  assert.doesNotMatch(source, /\{@html[^}]*?(?:error|detail)/i);
});

test('opens installed Assistant Help immediately before Send and clears it on Team change', () => {
  assert.match(source, /import AssistantHelpDrawer from '\$lib\/AssistantHelpDrawer\.svelte';/);
  assert.match(source, /class="help"[\s\S]*aria-expanded=\{helpOpen\}[\s\S]*aria-controls="assistant-help-drawer"/);
  assert.match(
    source,
    /<button[\s\S]*class="help"[\s\S]*>\?<\/button>[\s\S]*<button class="send"/,
  );
  assert.match(source, /disabled=\{helpAssistants\.length === 0\}/);
  assert.match(source, /const selected = new Set\(\$teamContext\.selectedAssistantIds\)/);
  assert.match(source, /runtime\.status === 'running' && selected\.has\(runtime\.assistant\)/);
  assert.match(source, /function activateTeam\(nextTeamId\)[\s\S]*helpOpen = false;/);
  assert.match(source, /<AssistantHelpDrawer[\s\S]*teamId=\{chatTeamId\}[\s\S]*assistants=\{helpAssistants\}/);
  assert.match(source, /\.chat-workspace\.drawer-open \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
});

test('keeps Team, Brain, and Assistant context attached to every composer state', () => {
  assert.match(source, /import ChatContextControls from '\$lib\/ChatContextControls\.svelte';/);
  assert.match(
    source,
    /<form class="composer"[\s\S]*?<ChatContextControls disabled=\{busy \|\| stopping\} \/>[\s\S]*?<div class="composer-input">/,
  );
  assert.match(source, /<section class="provider-setup"[\s\S]*?<div class="context-dock"><ChatContextControls \/><\/div>/);
  assert.match(source, /<section class="empty-state"[\s\S]*?<div class="context-dock"><ChatContextControls \/><\/div>/);
  assert.match(source, /Create a Team below to start chatting\./);
  assert.doesNotMatch(source, /from the sidebar|pela barra lateral/);
});

test('loads Help lazily per installed Assistant with an accessible multilingual drawer', () => {
  assert.match(drawerSource, /import \{ getAssistantHelp \} from '\$lib\/localApi\.js';/);
  assert.match(drawerSource, /if \(!open \|\| !currentTeam \|\| !currentAssistant\)/);
  assert.match(drawerSource, /const currentLocale = \$locale;/);
  assert.match(drawerSource, /getAssistantHelp\(fetch, currentTeam, currentAssistant, currentLocale\)/);
  assert.doesNotMatch(drawerSource, /activeAssistant\?\.name/);
  assert.match(drawerSource, /assistants\.length > 1[\s\S]*<select id="assistant-help-select"/);
  assert.match(drawerSource, /event\.key === 'Escape'[\s\S]*onclose\?\.\(\)/);
  assert.match(drawerSource, /bind:this=\{closeButton\}/);
  for (const locale of ['en', 'pt', 'es', 'zh', 'fr', 'de', 'ja', 'ar']) {
    assert.match(drawerSource, new RegExp(`\\b${locale}: \\{`));
  }
});

test('keeps Assistant Help at full viewport height across desktop and narrow layouts', () => {
  assert.match(
    drawerSource,
    /aside \{[\s\S]*height: 100vh;\s*height: 100dvh;[\s\S]*max-height: 100dvh;/,
  );
  assert.match(
    drawerSource,
    /@media \(max-width: 820px\) \{\s*aside \{ position: fixed; z-index: 110; inset-block: 0; inset-inline-end: 0;/,
  );
});

test('renders only closed Svelte Help nodes without an HTML injection escape hatch', () => {
  assert.doesNotMatch(`${drawerSource}\n${markdownSource}\n${inlineSource}`, /\{@html/i);
  for (const element of ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'pre', 'code', 'strong', 'em']) {
    assert.match(`${markdownSource}\n${inlineSource}`, new RegExp(`<${element}(?:>|\\s)`));
  }
  assert.match(inlineSource, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(inlineSource, /src=|style=|onerror=|onclick=/i);
});
