<script>
  import { locale } from '$lib/i18n.js';
  import { configureModelContext, loadModelContext, modelContext } from '$lib/modelContext.js';

  const COPY = {
    en: {
      eyebrow: 'Secure model setup',
      title: 'Brain BYOK',
      lead: 'Bring your own model API key to start this private Team chat. The key stays sealed inside your local Admin.',
      provider: 'Provider', model: 'Model', key: 'API key', keyPlaceholder: 'Paste your API key',
      verified: 'Verified key ready', required: 'Validation required', startChatting: 'Start Chatting',
      validating: 'Validating securely…', loading: 'Loading model settings…',
      retry: 'Try again', ready: 'Everything is ready',
    },
    pt: {
      eyebrow: 'Configuração segura do modelo',
      title: 'Brain BYOK',
      lead: 'Use sua própria chave de API de modelo para iniciar este chat privado do Time. A chave permanece protegida no seu Admin local.',
      provider: 'Provider', model: 'Modelo', key: 'Chave da API', keyPlaceholder: 'Cole sua chave da API',
      verified: 'Chave validada e pronta', required: 'Validação necessária', startChatting: 'Começar a conversar',
      validating: 'Validando com segurança…', loading: 'Carregando configuração do modelo…',
      retry: 'Tentar novamente', ready: 'Está tudo certo',
    },
    es: {
      eyebrow: 'Configuración segura del modelo',
      title: 'Brain BYOK',
      lead: 'Usa tu propia clave de API de modelo para iniciar este chat privado del Equipo. La clave permanece protegida en tu Admin local.',
      provider: 'Proveedor', model: 'Modelo', key: 'Clave de API', keyPlaceholder: 'Pega tu clave de API',
      verified: 'Clave verificada y lista', required: 'Validación necesaria', startChatting: 'Empezar a chatear',
      validating: 'Validando de forma segura…', loading: 'Cargando ajustes del modelo…',
      retry: 'Reintentar', ready: 'Todo está listo',
    },
    zh: {
      eyebrow: '安全模型设置',
      title: 'Brain BYOK',
      lead: '使用你自己的模型 API 密钥开始此团队的私密聊天。密钥始终密封保存在本地 Admin 中。',
      provider: '提供商', model: '模型', key: 'API 密钥', keyPlaceholder: '粘贴你的 API 密钥',
      verified: '已验证的密钥已就绪', required: '需要验证', startChatting: '开始聊天',
      validating: '正在安全验证…', loading: '正在加载模型设置…',
      retry: '重试', ready: '一切准备就绪',
    },
    fr: {
      eyebrow: 'Configuration sécurisée du modèle',
      title: 'Brain BYOK',
      lead: 'Utilisez votre propre clé d’API de modèle pour démarrer le chat privé de cette Équipe. La clé reste protégée dans votre Admin local.',
      provider: 'Fournisseur', model: 'Modèle', key: 'Clé API', keyPlaceholder: 'Collez votre clé API',
      verified: 'Clé vérifiée et prête', required: 'Validation requise', startChatting: 'Commencer à discuter',
      validating: 'Validation sécurisée…', loading: 'Chargement des paramètres du modèle…',
      retry: 'Réessayer', ready: 'Tout est prêt',
    },
    de: {
      eyebrow: 'Sichere Modelleinrichtung',
      title: 'Brain BYOK',
      lead: 'Verwenden Sie Ihren eigenen Modell-API-Schlüssel, um den privaten Chat dieses Teams zu starten. Der Schlüssel bleibt sicher in Ihrem lokalen Admin.',
      provider: 'Anbieter', model: 'Modell', key: 'API-Schlüssel', keyPlaceholder: 'API-Schlüssel einfügen',
      verified: 'Verifizierter Schlüssel bereit', required: 'Validierung erforderlich', startChatting: 'Chat starten',
      validating: 'Wird sicher validiert…', loading: 'Modelleinstellungen werden geladen…',
      retry: 'Erneut versuchen', ready: 'Alles ist bereit',
    },
    ja: {
      eyebrow: '安全なモデル設定',
      title: 'Brain BYOK',
      lead: '独自のモデル API キーを使って、このチームのプライベートチャットを開始します。キーはローカル Admin 内に安全に保管されます。',
      provider: 'プロバイダー', model: 'モデル', key: 'API キー', keyPlaceholder: 'API キーを貼り付け',
      verified: '検証済みのキーを使用できます', required: '検証が必要です', startChatting: 'チャットを開始',
      validating: '安全に検証中…', loading: 'モデル設定を読み込み中…',
      retry: '再試行', ready: '準備が整いました',
    },
    ar: {
      eyebrow: 'إعداد آمن للنموذج',
      title: 'Brain BYOK',
      lead: 'استخدم مفتاح API الخاص بنموذجك لبدء الدردشة الخاصة بهذا الفريق. يبقى المفتاح محميًا داخل Admin المحلي.',
      provider: 'المزوّد', model: 'النموذج', key: 'مفتاح API', keyPlaceholder: 'ألصق مفتاح API',
      verified: 'المفتاح المتحقق منه جاهز', required: 'التحقق مطلوب', startChatting: 'ابدأ الدردشة',
      validating: 'جارٍ التحقق بأمان…', loading: 'جارٍ تحميل إعدادات النموذج…',
      retry: 'إعادة المحاولة', ready: 'كل شيء جاهز',
    },
  };

  let apiKey = $state('');
  let submitting = $state(false);
  let copy = $derived(COPY[$locale] ?? COPY.en);
  let selected = $derived($modelContext.providers.find((entry) => entry.id === $modelContext.provider) ?? null);
  let selectedModel = $derived(selected?.models.find((entry) => entry.id === $modelContext.model) ?? null);

  async function submit(event) {
    event.preventDefault();
    if (submitting || !$modelContext.teamId || !selected) return;
    submitting = true;
    try {
      await configureModelContext(fetch, $modelContext.teamId, selected.configured ? '' : apiKey);
      apiKey = '';
    } catch {
      apiKey = '';
    } finally {
      submitting = false;
    }
  }

  function retry() {
    if ($modelContext.teamId) loadModelContext(fetch, $modelContext.teamId).catch(() => {});
  }
</script>

<section class="provider-gate" aria-labelledby="provider-gate-title">
  <div class="gate-mark" aria-hidden="true"><span></span></div>
  <p class="eyebrow">{copy.eyebrow}</p>
  <h2 id="provider-gate-title">{copy.title}</h2>
  <p class="lead">{copy.lead}</p>

  {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
    <p class="loading" role="status">{copy.loading}</p>
  {:else if !selected || !selectedModel}
    <div class="gate-error" role="alert">
      <span>{$modelContext.error || copy.loading}</span>
      <button type="button" onclick={retry}>{copy.retry}</button>
    </div>
  {:else}
    <form onsubmit={submit}>
      <dl>
        <div><dt>{copy.provider}</dt><dd>{selected.title}</dd></div>
        <div><dt>{copy.model}</dt><dd>{selectedModel.title}</dd></div>
      </dl>

      <p class:verified={selected.configured} class="verification">
        <span aria-hidden="true">{selected.configured ? '✓' : '◇'}</span>
        {selected.configured ? copy.verified : copy.required}
      </p>

      {#if !selected.configured}
        <label>
          <span>{copy.key}</span>
          <input
            type="password"
            bind:value={apiKey}
            placeholder={copy.keyPlaceholder}
            minlength="16"
            maxlength="8192"
            autocomplete="off"
            spellcheck="false"
            required
            disabled={submitting || $modelContext.phase === 'saving'}
          />
        </label>
      {/if}

      {#if $modelContext.error}<p class="gate-error" role="alert">{$modelContext.error}</p>{/if}
      <button
        class="unlock"
        type="submit"
        disabled={submitting || $modelContext.phase === 'saving' || (!selected.configured && apiKey.trim().length < 16)}
      >
        {submitting || $modelContext.phase === 'saving'
          ? copy.validating
          : copy.startChatting}
      </button>
    </form>
  {/if}
</section>

<style>
  .provider-gate {
    display: grid;
    width: min(34rem, calc(100% - 2rem));
    justify-items: center;
    margin: auto;
    padding: clamp(1.3rem, 4vw, 2.2rem);
    text-align: center;
  }
  .gate-mark { display: grid; width: 2.4rem; height: 2.4rem; place-items: center; margin-bottom: 0.9rem; border: 1px solid var(--accent); transform: rotate(45deg); }
  .gate-mark span { width: 0.55rem; height: 0.55rem; background: var(--accent); box-shadow: 0 0 10px rgba(0, 240, 255, 0.6); }
  .eyebrow { margin: 0 0 0.45rem; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; letter-spacing: 0.12em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(1.45rem, 4vw, 2.15rem); letter-spacing: -0.05em; }
  .lead { max-width: 29rem; margin: 0.75rem 0 0; color: var(--text-dim); font-size: 0.76rem; line-height: 1.55; }
  form { display: grid; width: 100%; gap: 0.8rem; margin-top: 1.25rem; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; border: 1px solid var(--admin-divider); }
  dl div { display: grid; gap: 0.25rem; padding: 0.7rem; text-align: start; }
  dl div + div { border-inline-start: 1px solid var(--admin-divider); }
  dt, label > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.09em; text-transform: uppercase; }
  dd { min-width: 0; margin: 0; overflow: hidden; font-family: var(--font-mono); font-size: 0.68rem; text-overflow: ellipsis; white-space: nowrap; }
  .verification { margin: 0; color: var(--danger); font-family: var(--font-mono); font-size: 0.62rem; letter-spacing: 0.05em; text-transform: uppercase; }
  .verification.verified { color: var(--success); }
  label { display: grid; gap: 0.35rem; text-align: start; }
  input { width: 100%; min-height: 2.8rem; border: 1px solid var(--border-strong); padding: 0 0.8rem; background: #020304; color: var(--text); font-family: var(--font-mono); }
  input:focus-visible { border-color: var(--accent); outline: 1px solid var(--accent); outline-offset: 1px; }
  button { min-height: 2.7rem; border: 1px solid var(--border-strong); padding: 0 0.85rem; background: transparent; color: var(--accent); cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  button.unlock { border: 0; background: linear-gradient(90deg, var(--accent), #8feaf3 55%, var(--accent-alt)); color: #001013; }
  button:disabled { cursor: not-allowed; opacity: 0.42; }
  .loading { margin: 1rem 0 0; color: var(--text-faint); font-family: var(--font-mono); font-size: 0.68rem; }
  .gate-error { display: flex; width: 100%; align-items: center; justify-content: center; gap: 0.7rem; margin: 0; color: var(--danger); font-size: 0.66rem; line-height: 1.45; }
  @media (max-width: 520px) { dl { grid-template-columns: 1fr; } dl div + div { border-inline-start: 0; border-top: 1px solid var(--admin-divider); } }
</style>
