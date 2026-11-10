# The assistant remembers the conversation

Date: 2026-11-10. Status: **Accepted** 2026-11-10 after the local review ("Accept and ship"). Request (owner, 2026-11-10: "Write the
ADR for conversation history and build it for review"), following the review
of `docs/adr-one-assistant-bar.md`, which found that the agent receives only
the current message.
Target: Continuum `v0.2.207-alpha`. No Suite or Teams change.

## Context

- The browser keeps each conversation. It is sealed with the owner's key
  (NIP-44) and stored on the server as ciphertext only (`src/session-crypto.js`,
  `/api/sessions`). The agent cannot read it.
- `POST /api/chat` takes one `message` (plus page context and attachments).
  The prompt is `[system, this message]`. So "what about the second one?" or
  "make it shorter" means nothing to the AI: every turn starts from zero.
- The prompt size matters. Routstr charges per token, and the local Ollama
  model on a low-spec VPS spends real time on every prompt token.

## Decision

1. **The browser sends the recent turns.** With each message, the bar sends
   `history`: the earlier turns of the same conversation (the one the message
   is pinned to), oldest first, as `{role: "user"|"assistant", text}`. Because
   the conversation is only readable in the browser, the browser is the only
   place that can do this; nothing new is stored on the server.
2. **Only real exchanges.** A turn is sent only as a pair: your message and
   the AI's actual answer to it. Greetings, error notices ("the provider timed
   out"), the top-up prompt and sign-in notices are never sent. To tell them
   apart, new AI replies are marked `ok` when saved. Messages saved before this
   version have no mark and are left out, so an older conversation gains
   memory from its next answer onwards.
3. **Bounded.** At most the last 20 messages (10 exchanges) and 24,000
   characters in total (about 6,000 tokens). The oldest are dropped first, and
   always as whole pairs. A single message longer than 8,000 characters is cut
   to its first 8,000. The browser applies these limits and the agent applies
   them again, so a modified browser cannot send more. The request stays well
   under nginx's 1 MB with the largest attachments.
4. **Names, not files.** Attachments are sent once. Earlier turns carry only
   their "Attached: name" line, as the saved conversation does today; images
   and file contents are never sent again.
5. **The AI does not repeat old commands.** The agent strips any fenced
   `store` block from earlier AI replies, so a past "add todo" cannot be
   echoed into a new change. Store writes still only come from the current
   reply.
6. **Local model gets less.** When a turn goes to Ollama (chosen or as the
   fallback), only the last 4 messages (2 exchanges) are kept, to protect the
   time limit on a slow VPS. Routstr gets the full bounded history.
7. **Priced honestly.** History is part of the prompt, so the existing
   per-turn estimate counts it, and the prompt-size log line includes it.
8. **Checks stay on the new message.** Code-side procedural guards run on the
   new message and attached files as today. Earlier turns were checked when
   they were sent; only the owner can call `/api/chat`, so a forged history
   gains nothing they could not type.
9. **Unchanged:** the episodic log records the current turn only; "New chat"
   starts with no history; opening a conversation from "All conversations"
   sends that conversation's turns.

## Wire format

```
POST /api/chat
{ "message": "...", "context": {...}, "attachments": [...],
  "history": [ {"role": "user", "text": "..."}, {"role": "assistant", "text": "..."} ] }
```

`history` is optional; older browsers keep working without it. A `history`
that is not an array of `{role, text}` with a known role, or has more than 20
items, gets 400 `bad_history`.

## Consequences

- Follow-up questions work, in every page and in the workspace chat.
- Each turn costs more on Routstr, up to about 6,000 extra prompt tokens on a
  long conversation. Short conversations cost almost the same.
- Conversations from before this version start remembering only from their
  next answer.
- Later: a summary of turns older than the window, if 10 exchanges proves
  too short.

## Tests

- Agent: `parseHistory` (types, roles, count, per-item cut, total budget,
  whole pairs, leading assistant dropped, `store` blocks stripped); the chat
  skill builds `[system, ...history, user]`; the router trims for Ollama;
  `/api/chat` rejects a bad `history` with `bad_history`.
- Browser: `buildHistory` (pairs only, `ok` replies only, greeting and errors
  left out, fallback note stripped, limits); a sent turn includes the previous
  exchange; replies are saved with `ok`.
