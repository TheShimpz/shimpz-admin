// Chat attachment scenarios (ADR-0093): uploads through Admin's Team file route, a reply whose message carried
// readable files and so withheld Actions, an attachment-free install guidance, and an approval that discloses the one
// original file its Action receives. Nothing here reaches a real Admin or Team.
import { localizedChallenge } from './localizedRequest.js';

const LIMIT_BYTES = 1024 * 1024 * 1024;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function mediaType(value) {
  const type = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return MEDIA_TYPE_RE.test(type) ? type : 'application/octet-stream';
}

/**
 * POST /api/teams/marketing/files with one multipart `file` part, given as `{ file: { name, type, size } }`. A full
 * Team answers 507 like Team's quota; a name ending in `.refused` answers 400 like Admin's filename refusal. Like Team,
 * an identical upload (here the same name, type, and size) reuses the stored file without charging the quota again.
 */
export function uploadFile(state, body) {
  const file = body?.file;
  if (!file || typeof file.name !== 'string' || !file.name || !Number.isSafeInteger(file.size) || file.size < 1) {
    return { status: 400, json: { detail: 'multipart body must contain only one file field' } };
  }
  if (state.uploads === 'full') {
    return { status: 507, json: { detail: 'Team storage quota exceeded', code: 'storage-quota-exceeded' } };
  }
  if (file.name.endsWith('.refused')) return { status: 400, json: { detail: 'filename is invalid' } };
  state.files ??= [];
  let stored = state.files.find((item) => (
    item.name === file.name && item.media_type === mediaType(file.type) && item.size === file.size
  ));
  if (!stored) {
    state.sequence += 1;
    state.usedBytes = (state.usedBytes ?? 0) + file.size;
    stored = {
      id: `${'e'.repeat(24)}${state.sequence.toString(16).padStart(8, '0')}`,
      name: file.name,
      media_type: mediaType(file.type),
      size: file.size,
      sha256: 'ab'.repeat(32),
      created_at: 1_790_000_000 + state.sequence,
    };
    state.files = [...state.files, stored];
  }
  return {
    status: 201,
    json: {
      team_id: 'marketing',
      file: { ...stored },
      used_bytes: state.usedBytes,
      limit_bytes: LIMIT_BYTES,
      remaining_bytes: LIMIT_BYTES - state.usedBytes,
    },
  };
}

// Team's attachment guidance in the interface language the message was written in (Admin assistant_route.py).
const LIFECYCLE_GUIDANCE = Object.freeze({
  en: "Attachments can't be used to install or remove Assistants. Send that request again without attachments.",
  pt: 'Anexos não podem ser usados para instalar ou remover Assistentes. Envie esse pedido de novo sem anexos.',
});

// A message that carried readable files: Team read them, and withheld every Action that does not ask a person first.
export function attachmentReply(teamName, frame) {
  const message = typeof frame.message === 'string' ? frame.message : '';
  if (/\b(?:instal|install|uninstall|desinstal|remov)/iu.test(message)) {
    return {
      type: 'assistant-guidance',
      team_id: 'marketing',
      code: 'assistant-lifecycle-attachments',
      reply: LIFECYCLE_GUIDANCE[frame.locale] ?? LIFECYCLE_GUIDANCE.en,
    };
  }
  return {
    type: 'done',
    team_id: 'marketing',
    team_name: teamName,
    reply: `I read the ${frame.files.length === 1 ? 'file' : `${frame.files.length} files`} you attached. `
      + 'The contract renews on 1 March and its notice period is 60 days.',
    clarification: null,
    usage: { duration_ms: 4810, models: [{ provider: 'openai', model: 'gpt-6-luna', input_tokens: 9_400, output_tokens: 210 }] },
    restricted_actions: {
      actions: [
        { assistant: 'shimpz-cloudflare', action: 'create-dns-record' },
        { assistant: 'shimpz-cloudflare', action: 'purge-cache' },
      ],
      total: 3,
    },
  };
}

// An approval whose Action receives the selected original, with any metadata embedded in it (ADR-0093).
const FILE_REQUEST = Object.freeze({
  kind: 'approval',
  ordinal: 0,
  title: 'Upload Contract.pdf to the R2 bucket “contracts”?',
  description: 'Cloudflare R2 stores a copy of the file. Anyone with access to the bucket can open it.',
  fingerprint: 'f'.repeat(64),
});
const FILE_COPY = Object.freeze({
  pt: {
    title: 'Enviar Contract.pdf ao bucket R2 “contracts”?',
    description: 'O Cloudflare R2 guarda uma cópia do arquivo. Quem tiver acesso ao bucket pode abri-lo.',
  },
});

export function fileApprovalChallenge(locale) {
  return {
    type: 'human-required',
    challenge_id: 'c'.repeat(32),
    expires_in: 180,
    assistant: { id: 'shimpz-cloudflare', name: 'Shimpz Cloudflare', version: '0.4.1' },
    action: { id: 'upload-object', summary: 'Upload one file to an R2 bucket.' },
    file: {
      id: 'e'.repeat(32),
      name: 'Contract.pdf',
      media_type: 'application/pdf',
      size: 482_133,
      sha256: 'ab'.repeat(32),
    },
    ...localizedChallenge(FILE_REQUEST, { locale, shown: FILE_COPY[locale] ?? {} }),
  };
}
