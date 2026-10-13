// The labels of a composed clarification answer in every interface language: the Team protocol's CLARIFICATION_LABELS
// (backend/protocol/http/v1/payload.py, ADR-0101), by which Team reads the person's own lines. An answer composed in one
// language still closes a question asked in another, so the chat keeps every language's pair loaded.
export const CLARIFICATION_LABELS = {
  en: { question: 'Question', answer: 'Answer' },
  pt: { question: 'Pergunta', answer: 'Resposta' },
  es: { question: 'Pregunta', answer: 'Respuesta' },
  zh: { question: '问题', answer: '回答' },
  fr: { question: 'Question', answer: 'Réponse' },
  de: { question: 'Frage', answer: 'Antwort' },
  ja: { question: '質問', answer: '回答' },
  ar: { question: 'السؤال', answer: 'الإجابة' },
};
