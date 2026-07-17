/**
 * Pure builder for the task prompt sent (via the chat dock) to the Continuum
 * agent when an operator asks it to "vibe code" a card. Kept DOM-free and side
 * effect-free so it is unit-testable without a browser: board.js imports it and
 * feeds the result to chat.compose(), which only prefills — the operator hits
 * Send (agent turns cost sats).
 */

const MAX_PROMPT = 600;

export function buildCardPrompt(card, projectName, columnName) {
  const c = (card && card.content) || card || {};
  const title = (c.title || '').trim();
  const description = (c.description || '').trim();
  const project = (projectName || '').trim();
  const column = (columnName || '').trim();

  let out = 'Work on this task.\n';
  out += `Title: ${title}\n`;
  if (description) out += `Details: ${description}\n`;
  if (project) out += `Project: ${project}\n`;
  if (column) out += `Status: ${column}\n`;

  out = out.trimEnd();
  if (out.length > MAX_PROMPT) out = out.slice(0, MAX_PROMPT).trimEnd();
  return out;
}
