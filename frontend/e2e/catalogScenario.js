// The owner's Local Assistants catalog (ADR-0087 preview): four staged Assistants, two of them installed in Marketing,
// with each page's copy in English and Portuguese as Team reads it from every snapshot's own language pack. Any other
// interface language shows the English copy, as a snapshot staged without a translation key does (ADR-0091).

const READ = 'read_only';
const WRITE = 'mutating';

function actions(list) {
  return list
    .map(([id, effect, en, pt]) => ({ id, effect, description: { en, pt } }))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
}

const ASSISTANTS = [
  {
    id: 'meta-ads',
    version: '0.1.0',
    name: 'Meta Ads',
    hex: 'a',
    summary: {
      en: "Find where your ads pay off and cut the spend that doesn't convert.",
      pt: 'Descubra onde seus anúncios dão resultado e corte o gasto que não converte.',
    },
    description: {
      en: 'Stop getting lost in Ads Manager. Ask how much each campaign spent, how many contacts it brought and what each one cost, and see which ad works best. When a campaign spends without results, ask to pause it or change its budget. Nothing changes without your password.',
      pt: 'Chega de se perder no Gerenciador de Anúncios. Pergunte quanto cada campanha gastou, quantos contatos trouxe e quanto custou cada um, e veja qual anúncio funciona melhor. Quando uma campanha estiver gastando sem resultado, peça para pausar ou mudar o orçamento. Nada muda sem a sua senha.',
    },
    links: {
      site: 'https://shimpz.com/',
      github: 'https://github.com/TheShimpz',
      x: 'https://x.com/shimpz',
      youtube: 'https://www.youtube.com/@shimpz',
    },
    storedInputs: [
      ['meta-access-token', 'Meta access token', 'Token de acesso da Meta'],
      ['meta-app-secret', 'Meta app secret', 'Chave secreta do app Meta'],
    ],
    integrations: [],
    actions: actions([
      ['list-ad-accounts', READ, 'See your ad accounts', 'Ver suas contas de anúncio'],
      ['get-ad-account', READ, 'See the details of one ad account', 'Ver os dados de uma conta de anúncio'],
      ['list-campaigns', READ, 'See your campaigns', 'Ver suas campanhas'],
      ['get-insights', READ, 'See the results of a period', 'Ver os resultados de um período'],
      ['set-campaign-status', WRITE, 'Pause or start a campaign', 'Pausar ou ativar uma campanha'],
      ['set-campaign-budget', WRITE, "Change a campaign's budget", 'Mudar o orçamento de uma campanha'],
    ]),
  },
  {
    id: 'shimpz-cloudflare',
    version: '0.5.2',
    name: 'Cloudflare',
    hex: 'b',
    summary: {
      en: "Set up your domains' DNS without opening a dashboard or memorizing records.",
      pt: 'Configure o DNS dos seus domínios sem abrir painel nem decorar registro.',
    },
    description: {
      en: "Pointing a subdomain, verifying a domain with Google, or finding out why a site won't load usually takes record types and dashboard clicks. Here you ask in plain words: it checks what already exists, shows exactly what will change, and applies it only with your password.",
      pt: 'Apontar um subdomínio, verificar o domínio no Google ou entender por que o site não abre costuma exigir tipos de registro e cliques no painel. Aqui você pede em português: ele confere o que já existe, mostra exatamente o que vai mudar e só aplica com a sua senha.',
    },
    links: { site: 'https://shimpz.com/', github: 'https://github.com/TheShimpz/shimpz-cloudflare' },
    storedInputs: [],
    integrations: ['cloudflare'],
    actions: actions([
      ['list-zones', READ, 'See your domains', 'Ver seus domínios'],
      ['get-zone', READ, 'See the details of one domain', 'Ver os dados de um domínio'],
      ['list-dns-records', READ, "See a domain's DNS records", 'Ver os registros de DNS de um domínio'],
      ['ensure-dns-record', WRITE, 'Create or correct a DNS record', 'Criar ou acertar um registro de DNS'],
      ['delete-dns-record', WRITE, 'Remove a DNS record', 'Remover um registro de DNS'],
    ]),
  },
  {
    id: 'shimpz-exa',
    version: '0.2.1',
    name: 'Exa',
    hex: 'c',
    summary: {
      en: 'Up-to-date answers from the web, with the source of every fact.',
      pt: 'Respostas atualizadas da internet, com a fonte de cada informação.',
    },
    description: {
      en: 'Searching, opening site after site, and checking what to trust takes time. Ask for the news in your field, a price comparison, or a summary of an article: it searches, reads the most relevant pages, and answers citing where each fact came from. It only reads; it never publishes anything.',
      pt: 'Pesquisar, abrir site por site e conferir se dá para confiar toma tempo. Peça as notícias do seu setor, uma comparação de preços ou o resumo de um artigo: ele busca, lê as páginas mais relevantes e responde citando de onde veio cada dado. Ele só lê; nunca publica nada.',
    },
    links: { site: 'https://shimpz.com/', linkedin: 'https://www.linkedin.com/company/shimpz' },
    storedInputs: [['exa-api-key', 'Exa API key', 'Chave da Exa']],
    integrations: [],
    actions: actions([
      ['search-web', READ, 'Search the web', 'Pesquisar na internet'],
      ['read-pages', READ, 'Read web pages', 'Ler páginas da internet'],
    ]),
  },
  {
    id: 'whatsapp',
    version: '0.3.0',
    name: 'WhatsApp',
    hex: 'd',
    summary: {
      en: 'Notify your customers on WhatsApp without typing message after message.',
      pt: 'Avise seus clientes no WhatsApp sem digitar mensagem por mensagem.',
    },
    description: {
      en: 'Confirming orders, reminding appointments, and sending notices fill the day. Ask for the message, review the text, and approve: it sends it from your official WhatsApp Business account. No message leaves without your password.',
      pt: 'Confirmar pedido, lembrar consulta e mandar aviso tomam o dia. Peça a mensagem, revise o texto e aprove: ele envia pela sua conta oficial do WhatsApp Business. Nenhuma mensagem sai sem a sua senha.',
    },
    links: { site: 'https://shimpz.com/', instagram: 'https://www.instagram.com/shimpz' },
    storedInputs: [['whatsapp-token', 'WhatsApp Business token', 'Token do WhatsApp Business']],
    integrations: [],
    actions: actions([['send-message', WRITE, 'Send a message', 'Enviar uma mensagem']]),
  },
];

export const CATALOG_INSTALLED = Object.freeze(['shimpz-cloudflare', 'shimpz-exa']);

const imageId = (assistant) => `sha256:${assistant.hex.repeat(64)}`;
const text = (copy, locale) => copy[locale] ?? copy.en;

/** The staged snapshots `/api/local-assistants` lists. */
export function catalogSnapshots() {
  return ASSISTANTS.map((assistant) => ({
    assistant_id: assistant.id,
    assistant_version: assistant.version,
    name: assistant.name,
    summary: assistant.summary.en,
    actions: assistant.actions.map((action) => action.id),
    integrations: [...assistant.integrations],
    declared_creators: ['@shimpz'],
    created_at: '2026-10-08T07:00:00Z',
    image_id: imageId(assistant),
    platform: 'linux/amd64',
    provenance: 'local',
    unpublished: true,
  }));
}

/** The installed bindings Marketing's inventory lists. */
export function catalogInventory() {
  return ASSISTANTS.filter((assistant) => CATALOG_INSTALLED.includes(assistant.id)).map((assistant) => ({
    assistant: assistant.id,
    assistant_version: assistant.version,
    status: 'running',
    provenance: 'local',
  }));
}

function details(assistant, locale) {
  return {
    locale,
    assistant_id: assistant.id,
    assistant_version: assistant.version,
    name: assistant.name,
    creators: ['@shimpz'],
    summary: text(assistant.summary, locale),
    description: text(assistant.description, locale),
    links: { ...assistant.links },
    actions: assistant.actions.map((action) => ({
      id: action.id,
      effect: action.effect,
      description: `${text(action.description, locale)}.`,
    })),
    integrations: assistant.integrations.map((id) => ({ id, provider: id })),
    stored_inputs: assistant.storedInputs
      .map(([id, en, pt]) => ({ id, label: text({ en, pt }, locale) }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
  };
}

/** One staged image's page or summary, or null for an image this catalog does not stage. */
export function catalogImageAnswer(path, locale) {
  const match = /^\/api\/local-assistants\/([0-9a-f]{64})\/(summary|details)$/.exec(path);
  const assistant = match && ASSISTANTS.find((entry) => imageId(entry) === `sha256:${match[1]}`);
  if (!assistant) return null;
  return match[2] === 'summary' ? { locale, summary: text(assistant.summary, locale) } : details(assistant, locale);
}

/** One installed binding's page, or null when Marketing does not run that Assistant. */
export function catalogBindingAnswer(path, locale) {
  const match = /^\/api\/teams\/marketing\/assistants\/([a-z0-9-]+)\/details$/.exec(path);
  const assistant = match && CATALOG_INSTALLED.includes(match[1]) && ASSISTANTS.find((entry) => entry.id === match[1]);
  return assistant ? details(assistant, locale) : null;
}
