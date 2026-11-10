# One assistant bar everywhere, with "+" for images and files

Date: 2026-11-10. Status: **Accepted** 2026-11-10 after the local review ("Accept and ship"). Request (owner, 2026-11-10: "this chat bar should
be the same throughout... we can remove the two buttons 'context' and 'this
page'... the chat panel to the ai should be aware of which page its on and the
human can tell them... replace these two buttons with a '+' button to add
images or files... this chat panel must be consistent throughout the app").
Target: Continuum `v0.2.206-alpha`. No Suite or Teams change. Amends
CHAT-CONTEXT-1 (`src/chat-threads.js`: one conversation per page or project,
plus a "General" side conversation).

## Context

- The bar at the bottom is the owner's line to their own AI. It is one
  component (`src/chat.js`) used as the floating dock on every page and moved,
  not copied, into a project's workspace chat.
- It shows two controls before the message box: a "Context · Dashboard" label
  and a "This page / General" switch. The switch picks which of several
  conversations you are in: one per page (Dashboard, Marketplace...), one per
  project, or a "General" one. Moving between pages swaps the conversation
  under you, so the bar looks the same but is not the same chat. In the
  workspace the two controls are hidden, so the bar also looks different there.
- The AI already gets the page with every message (label, route, page type,
  project), but its prompt only uses the label.
- The bar takes text only. There is no way to show the AI a screenshot or hand
  it a file.

## Decision

1. **One bar, one look.** The "Context" label and the "This page / General"
   switch are removed everywhere. The bar is `[+] [message box] [Send] [▲]`
   on every page; in the workspace, where the chat fills the panel, only the
   ▲ (collapse) is hidden, as today.
2. **One running conversation.** The dock keeps one conversation that follows
   you from page to page (it reuses the existing "General" conversation, so
   nothing is lost). Earlier per-page and per-project conversations stay in
   "All conversations" and can be reopened; opening one, or starting "New
   chat", works as today.
3. **The AI knows where you are.** Each message still carries the page, and
   the prompt now says it in full: page name, page type, route and project
   slug when there is one, for example `The operator is on the "Torii Quest"
   project board (project-board, /projects/torii-quest/board, project
   torii-quest).` The owner can also just say "I'm on the board". The prompt
   tells the AI the page can change between messages in the same
   conversation.
4. **"+" adds images or files.** It opens a file picker (paste an image into
   the box also works). Chosen items show as small removable chips above the
   box and go with the next message. Limits, checked in the browser and again
   on the agent:
   - up to 4 items per message;
   - images: PNG, JPEG, WebP or GIF. The browser shrinks each to at most
     1568 px on the long side and re-encodes it as JPEG (transparent areas
     become white, an animated GIF keeps its first frame), so a phone photo
     of several MB becomes a few hundred KB. The agent checks the file's first bytes match its type;
   - files: plain text only (txt, md, csv, json, yaml, html, css, js, ts, py,
     sh, log and similar), UTF-8, up to 100 KB each and 200 KB in total.
     They are sent to the AI as text, fenced as untrusted data (like retrieved
     memory), so a file cannot give the AI instructions;
   - the whole message must fit under nginx's existing 1 MB request limit,
     so no Suite change is needed; the agent's limit for `/api/chat` goes
     from 512 KB to the same 1 MB (other routes keep 512 KB). If it doesn't, the
     bar says so before anything is sent. PDFs and Office files are out of
     scope for now.
5. **Images need a model that can see.** The agent reads each Routstr model's
   advertised input types from the catalog. A message with an image only goes
   to models that list `image`; if the owner's chosen model can't read
   images, the turn stops before any payment with "Your chat model can't read
   images. Choose one that can on the Routstr page." The free local fallback
   is skipped for image turns (it can't see them) rather than answering
   blind. Text files work with any model.
6. **Nothing extra is stored.** Attachments are sent once with that message.
   The conversation history (sealed and saved as today) keeps only "Attached:
   name" lines, not the image or file contents, and the agent's episodic log
   records the names only.
7. **Cost is honest.** The pre-payment estimate counts each image as about
   1,600 prompt tokens plus the text of any files, so a picture can't
   underpay a request; the operator's per-request ceiling still applies.

## Consequences

- The bar is identical on every page and in the workspace, and the
  conversation no longer changes under you when you move around.
- Owners lose the one-click "General" side conversation; "New chat" replaces
  it.
- Screenshots and small text files can be shown to the AI. Image turns cost
  more and need a vision model; the default `deepseek-v4-flash` is text-only,
  so the owner picks a vision model on the Routstr page to use images.
- Request limits stay at 1 MB; very large files and PDFs need a later decision
  (and a Suite nginx change).

## Alternatives considered

- **Keep per-page conversations, just hide the controls.** Same look, but the
  chat still swaps under you, which is what "the same throughout" rules out.
- **Upload files to the node's file server and send links.** Keeps requests
  small, but the AI provider can't fetch private node URLs, and it would store
  every attachment on disk. Rejected for now.
- **Raise the request limit to 10 MB.** Needs a Suite nginx change on every
  install and makes slow, costly turns easy. Shrinking images in the browser
  makes it unnecessary.
