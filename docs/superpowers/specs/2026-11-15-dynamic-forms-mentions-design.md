# Dynamic forms, mentions and cross-project requests — design

**Date:** 2026-11-15 · **Status:** Draft (owner's request, translated: "We need forms that are filled in from JSON: we
give it a JSON and it lets you fill it in — email, password — and everything adapts through inputs, selects and so on.
Nothing hard-coded, all dynamic. Messages must be created dynamically and speak Markdown, with mentions and tags: for
example, tag another project and ask the agent of that project to do something there, then come back here and add it.
The UI must be dynamic.")
**Builds on:** [`2026-11-10-v7-changes-queue-approvals.md`](./2026-11-10-v7-changes-queue-approvals.md) (decision 43,
forms and secrets), [`2026-11-14-parallel-sessions-design.md`](./2026-11-14-parallel-sessions-design.md) (sessions,
caps, `session_reports`), [`2026-11-10-subscription-agents-design.md`](./2026-11-10-subscription-agents-design.md) (the
harness MCP server), [`2026-11-14-remote-access-mobile-design.md`](./2026-11-14-remote-access-mobile-design.md)
(permission classes). The UI part is recorded as UI decision 97 **(chosen by the spec)**.

Marks: **(chosen by the spec)** is a choice the owner did not make, with its reason in one line. UI copy below is
British English and uses the pass vocabulary: Octo (not orchestrator), request / reply (not turn), agent (not helper),
"Octo's local service" (not harness).

## 1. Today

**Forms (decision 43).** An agent opens a form with the tool `request_input` (`internal/orchestrator/secrets.go`,
`ToolRequestInput`; offered to built-in agents at every depth and, over MCP, to an ACP Octo). Input:
`{title, reason?, fields: [{id, label, kind, options?, required?, help?}]}`, exactly five kinds
`secret | text | select | confirm | path` (`internal/inputs/inputs.go`: `KindSecret…KindPath`, `MaxFields = 8`,
`MaxOptions = 24`, `MaxTextBytes = 16 KiB`, `Validate`, `check`). Open forms live in memory only (`inputs.Manager`,
`pending` map): nothing about a form is in SQLite; the stored transcript holds the `request_input` tool call and its
result. Routes `GET /v1/projects/{pid}/inputs`, `POST …/inputs/{id}` (`{skip}` or `{values}` → 204; a refusal is 400
naming field ids, never values), secrets routes `GET|PUT|DELETE …/secrets[/{name}]`; events `input.requested {input}`,
`input.resolved {id, status, provided, values}`, `secrets.changed {names}` (`apps/harness/docs/v7.md` §4). A secret
field's id is its secret name, the value goes to `{data-dir}/projects/{pid}/secrets.json` and the model sees
`use_as: "secret:<id>"`. Client: `InputFieldKind`, `InputField`, `InputRequest`, `InputAnswer`
(`packages/agent-client/src/types.ts`), `AnsweredInput` (`state.ts`), `Bridge.submitInput?` (`client.ts`). UI:
`components/v7/InputFormCard.tsx`, `FormFields.tsx` (segments for ≤ 4 options, `CHOICES_MAX`), `useInputForm.ts`,
`lib/v7/form.ts` (`validate`, `buildAnswer`, `fieldsInError` parses the 400 message, `answeredLine`: "Skipped",
"Closed: stopped"); settings use `components/shared/SecretForm.tsx`. Demo: one "Deploy settings" form in
`demo/v7.ts`. Mock markers `[ask]`, `[form]` (`internal/mockllm/v7.go`, `internal/fakeacp/v7.go`).

**MCP elicitation: not supported, and there is nothing to receive it.** `internal/mcp/server.go` is the harness's MCP
*server* (methods `initialize`, `ping`, `tools/list`, `tools/call`); elicitation is a server→client request, so it
would flow from the harness to the agent, not the other way. Plugin tool servers are not MCP: `internal/tools/remote`
speaks Octo's own HTTP protocol (`GET {base}/tools`, `POST {base}/tools/{name}`, 30 s timeout, sub-agents only). ACP
(`internal/acp/protocol.go`) handles `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` only.

**Mentions.** `@` at a word start opens `ComposerMenu` inline (`components/chat/ComposerMenu.tsx`): groups Attach,
Files, Agents, Comments, Project. Picking a file inserts plain text `` `folder/path` ``; picking an agent inserts the
sentence "Use the X agent for this."; `lib/mentions.ts` (`composerSpans`, decision 70) only tints `@path`-looking words
and leading `/commands` in `ComposerHighlight.tsx`. Nothing structured reaches the harness: no mention list, no ACP
`resource_link` (no match for `resource_link` in `apps/harness`). Code comments travel inside the request text as an
`octo-comments` fenced block (`lib/comments.ts`, `splitComments`, `SentComments.tsx`). `/new <text>` sends to a new
session (`Composer.tsx`, `OCTO_COMMAND_NAMES` in `lib/slash.ts`). Notes have `tags` (front matter, `memory.md`).

**Request bubble.** `UserPrompt` in `components/chat/Transcript.tsx` renders the request as plain text
(`whitespace-pre-wrap`, 8-line clamp, pill when one line); "From {author}" above it for a non-Octo transcript. Replies
use `components/shared/Markdown.tsx` (react-markdown + remark-gfm, no raw HTML, inline code links to files).

**Delegation.** `spawn_agent` (agents inside the project, `DelegationGroup.tsx` rows with "Open session"); parallel
sessions phases 1–2 (`POST /sessions` with `text`, `sendSessionMessage`, `max_running` default 3,
`HARNESS_MAX_RUNNING_SESSIONS` default 6, state `queued`, `waiting_for: "slot"`, `project.attention.sessions`);
coordination tools of phase 4 (`list_sessions`, `message_session`…) are not built. `session_reports`
(`AddSessionReport` / `TakeSessionReports`, schema 13) hands a note to a main session at its next request. Approvals:
kinds `write | command | acp | network` (`internal/approval`), always-allow rules `{tool, match, exact}`. Budgets per
project (`budget_usd`, `architecture.md`). Remote devices: classes read / send / answer / stop, read-only refuses
the rest (`remote-access.md`). Schema version 15 (`internal/projectstore/migrate.go`; next free 16).

## 2. Decisions

1. **One form format: the MCP elicitation schema plus `x-octo` keys.** A flat `type: "object"` whose properties are
   primitives (MCP 2025-06-18, enum forms of 2025-11-25); Octo additions live under `x-octo` so a plain MCP or JSON
   Schema reader still sees a valid, simpler form.
2. **`request_input` takes `schema` beside `fields`** (exactly one of them). The harness converts `fields` to a schema,
   so every `InputRequest` carries `schema`; `fields` stays on the wire for old clients and old transcripts.
3. **No migration for tool forms.** Open forms stay in memory as today; the transcript keeps the tool call, which now may
   hold `schema`. The UI's tool line reads both shapes.
4. **Validation lives in one Go package and one TS module with the same rules**; a refusal keeps HTTP 400
   `invalid_request` and gains `error.fields {id: message}` **(chosen by the spec: `e2e-v7.sh`, `v7_forms_test.go` and
   old clients' `fieldsInError` depend on 400)**.
5. **`format: "password"` is the only way to a secret**, and only from `request_input`. Markdown forms and tool-server
   forms cannot ask for one (refused at validation) — MCP itself forbids sensitive data in form elicitation.
6. **Conditional visibility is in v1, one condition per field** (`x-octo.visible_when {field, equals}`): it is what
   makes one form serve "token or password" without nesting; a hidden field is neither validated nor sent.
7. **Forms inside replies are an `octo-form` fenced block**, answerable only while it is in the session's last reply;
   the answer is a new request built by Octo's local service from `form_answer`, with an `octo-form-answer` block — the
   same pattern as `octo-comments`, so no new table.
8. **Tool servers may ask for a form** through an Octo extension of their HTTP protocol (a 200 body
   `{"octo_elicitation": …}`, then a re-invoke with the answer); real MCP elicitation needs an MCP client the harness
   does not have and is out of this spec.
9. **No person-made forms in v1**: nobody asked to send a form to an agent; the renderer makes it cheap later.
10. **A mention is a Markdown link with an `octo://` target**: `@[Atlas API](octo://project/prj_0001)`. It survives
    copy and paste, renders as a link in any Markdown viewer, a model reads it, and it carries a stable id beside a
    readable label; the text is the only carrier (no side list to fall out of step with queue edits, retry, rewind).
11. **The composer stays a text area**: it shows `@Atlas API` as a tinted atomic token and keeps the target beside the
    text; the link form is written on send **(chosen by the spec: a rich editor is a rewrite of the composer, phone
    sheet and highlight layer)**.
12. **`#tag` means a note tag of the project in v1**: `#deploy` puts the notes tagged `deploy` in the request's context.
    Tags on sessions and requests need new storage and a use nobody named yet; deferred.
13. **Requests render Markdown** with the reply renderer, minus headings, images and HTML; one line of plain prose is
    still a pill.
14. **`ask_project` is always in the tool list; a project the person mentioned in the request is allowed, any other
    needs an approval** of the new kind `project` with always-allow per (source, target) pair **(chosen by the spec:
    the mention is the person's consent, yet an agent that finds it needs another project is not dead-ended)**.
15. **The asked project works as itself**: a new main session there, its own Octo, settings, access, folders,
    approvals, budget and memory; the asking side gets only the final reply, changed files and state.
16. **Chains are at most two hops and never revisit a project** (A→B→C allowed, A→B→A refused).
17. **Stop in the asking request stops every ask that request started** and that still runs.
18. **The person's direct path `/ask @Project text` is in v1**: a new session in that project, a toast with "Open"
    in this one, nothing added to this conversation (the model never sees it).
19. **Schema 16 adds `sessions.origin_json` and a `project_asks` table** in each project's database; the parallel
    work that may take 16 first renumbers whichever lands second.

## Part A — Schema forms

### A.1 The schema

```ts
// packages/agent-client/src/types.ts
export type FormSchema = {
  type: "object";
  properties: Record<string, FormProperty>;
  required?: string[];
  /** Normalised by the service: `order` always lists every property. */
  "x-octo"?: { order?: string[]; groups?: { title: string; fields: string[] }[]; submit_label?: string };
};
export type FormChoice = { const: string; title: string };
export type FormCondition = { field: string; equals: string | number | boolean | (string | number | boolean)[] };
type Base = { title?: string; description?: string;
  "x-octo"?: { placeholder?: string; visible_when?: FormCondition; multiline?: boolean; step?: number;
               widget?: "path"; path_kind?: "file" | "folder"; accept?: boolean } };
export type FormProperty = Base & (
  | { type: "string"; format?: "email" | "uri" | "date" | "date-time" | "password"; minLength?: number;
      maxLength?: number; pattern?: string; default?: string }
  | { type: "string"; enum: string[]; enumNames?: string[]; default?: string }
  | { type: "string"; oneOf: FormChoice[]; default?: string }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "array"; items: { type: "string"; enum: string[] } | { anyOf: FormChoice[] };
      minItems?: number; maxItems?: number; default?: string[] });
export type FormValue = string | number | boolean | string[];
export type FormSource = { kind: "tool" } | { kind: "tool_server"; server: string; tool: string };
// InputRequest gains: schema: FormSchema; source?: FormSource. InputField stays.
export type InputAnswer = { skip?: boolean; values?: Record<string, FormValue> };
// AnsweredInput.values and InputResolvedEvent.values become Record<string, FormValue>.
```

```go
// internal/inputs/schema.go
type Schema struct {
	Type       string      `json:"type"`
	Properties Properties  `json:"properties"` // ordered: decoded token by token, document order kept
	Required   []string    `json:"required,omitempty"`
	Octo       *SchemaOcto `json:"x-octo,omitempty"`
}
type SchemaOcto struct {
	Order       []string `json:"order,omitempty"`
	Groups      []Group  `json:"groups,omitempty"`
	SubmitLabel string   `json:"submit_label,omitempty"`
}
type Property struct {
	Type, Title, Description, Format, Pattern string
	MinLength, MaxLength, MinItems, MaxItems   *int
	Minimum, Maximum                           *float64
	Enum, EnumNames                            []string
	OneOf                                      []Choice
	Items                                      *Items
	Default                                    json.RawMessage
	Octo                                       *PropertyOcto `json:"x-octo,omitempty"`
} // json tags as in the TS type
func ParseSchema(raw json.RawMessage, opts Origin) (Schema, error) // validates, normalises x-octo.order
func FromFields(fields []Field) Schema                            // the five legacy kinds
func CheckAnswer(s Schema, a Answer) (Result, map[string]string)  // Result as today; errors by property id
```

Example — sign in to staging (the agent's `request_input` input):

```json
{"title": "Sign in to staging", "reason": "The smoke tests log in as a test user.",
 "schema": {"type": "object", "required": ["email", "password"],
  "properties": {
   "email": {"type": "string", "format": "email", "title": "Email", "x-octo": {"placeholder": "you@example.com"}},
   "password": {"type": "string", "format": "password", "title": "Password", "minLength": 8},
   "remember": {"type": "boolean", "title": "Keep me signed in for this project", "default": true}}}}
```

The result the model sees is today's shape: `{"status":"submitted","values":{"email":"…","remember":true},
"secrets":{"password":"provided"},"use_as":{"password":"secret:password"}}`; numbers stay numbers, arrays arrays.

**Rules.** Property ids follow today's `fieldID` (letter first, `[A-Za-z0-9_.-]`, ≤ 64); a password id must also be a
valid secret name. Legacy mapping: `text` → string; `secret` → string + `password`; `select` → string + `enum`;
`confirm` → boolean (required → `x-octo.accept: true`, "must be ticked"); `path` → string + `x-octo.widget: "path"`;
`label` → `title`; `help` → `description`. Formats: `date` is RFC 3339 full-date, `date-time` RFC 3339 with offset (the
UI's local time is sent with the local offset), `email` one `@`, no spaces, a dot in the domain, `uri` absolute with a
scheme. `pattern` is unanchored (JSON Schema) and must compile in Go `regexp` (RE2), else the schema is refused.
`enum` + `enumNames` (legacy) and `oneOf`/`anyOf` const+title give labels. `visible_when.field` must be an earlier
property; `equals` is a value or a list of values (any of).

**Limits** (refused at validation, message names the limit): schema JSON ≤ 32 KiB; 1–20 properties (legacy `fields`
keep 1–8); ≤ 50 choices per enum and items; ≤ 8 groups; title ≤ 200, property title ≤ 120, description ≤ 500,
placeholder ≤ 120; pattern ≤ 256 bytes; string answers ≤ `MaxTextBytes`; secrets 4 bytes–16 KiB as today.

**Not in v1, with the reason.** Nested objects and arrays of objects (a form becomes an editor; MCP excludes them too);
`$ref`/`$defs`, `allOf`/`anyOf`/`if`/`then` beyond enum choices (no flat form needs them); more than one condition per
field or conditions on later fields (ordering and cycles); file upload (attachments exist); options loaded from a URL
(network from a card); sliders and ranges (number fields cover them); URL-mode elicitation (no MCP client).

### A.2 Sources

1. **`request_input` with `schema`** (built-in agents, and the harness MCP tool list for an ACP Octo — same JSON
   schema). `fields` and `schema` together, or neither: tool error "Pass fields or schema, not both".
2. **Tool servers** (decision 8). An invoke may answer 200 with `{"octo_elicitation": {"message": "...",
   "requestedSchema": {…}}}`; the service opens the form for that sub-agent's session (`source: {kind:"tool_server",
   server, tool}`), then re-POSTs the same URL with the original input plus `"_octo_elicitation": {"action":
   "accept"|"decline"|"cancel", "content": {...}}`. At most two forms per call; `password` refused; the content goes
   only to the tool server (the stored tool call holds the model's input, the result is the server's final answer).
3. **`octo-form` block in a reply** (decision 7):

````markdown
Which checks should I run before the release?

```octo-form
{"id": "checks", "title": "Release checks", "submit_label": "Run checks",
 "schema": {"type": "object", "required": ["checks"], "properties": {
   "checks": {"type": "array", "title": "Checks", "minItems": 1,
     "items": {"anyOf": [{"const": "unit", "title": "Unit tests"}, {"const": "lint", "title": "Lint"},
                         {"const": "e2e", "title": "End-to-end"}]}, "default": ["unit", "lint"]}}}}
```
````

   Octo's briefing (built-in and ACP) gains one paragraph on the block. The block renders once its fence is closed and
   the reply has finished ("Available when the reply finishes" before). Submitting calls `POST …/messages` (or the
   session route) with `{form_answer: {message_id, form_id, values}}` and no `text`; the service finds the block in
   that assistant message, validates, and stores a request whose text is
   `Answered "Release checks":` + an `octo-form-answer` block `{"form":"checks","message_id":812,"values":{…}}`. 409
   `form_stale` when the message is not the session's last reply; 422 is not used (decision 4: 400 with `fields`).
   An invalid block renders as an ordinary code block plus the note "This form could not be shown: <reason>".

### A.3 Validation

Client (`packages/ui/src/lib/forms/schema.ts`): parse + normalise (same limits, so a bad block fails the same way),
validate on blur and on submit, messages in the card's words: "Required", "Enter an email address like
name@example.com", "Enter a web address starting with https://", "Use 8 characters or more", "Enter a number from 1 to
10", "Enter a whole number", "Choose one", "Choose at least 1", "Doesn't match the expected format". `pattern` runs on the
client only when it has no quantified group containing a quantifier and the value is ≤ 1 KiB; otherwise the service
decides (RE2 is linear). Service: `inputs.CheckAnswer` with the same rules; unknown ids, hidden fields, wrong types are
refused. Defaults fill the initial values (a password never has one). **Skip** is "Skip" for tool forms (status
`skipped`, MCP `decline`); Markdown forms have no Skip (the person just writes a request).

### A.4 UI

One renderer, `components/forms/SchemaForm.tsx`, on primitives only: `TextField` (string, email, uri, date via
`type="date"`, date-time via `type="datetime-local"`, number with `inputMode` and `step`), `TextArea` (`multiline`),
password = today's secret field (eye toggle, never in state beyond the submit), `Segmented` (one-of with ≤ 4 choices of
≤ 16 characters), `Select` (other one-of), `Checkbox` list (many-of ≤ 6) or a multi-select `Select` (more), `Switch`
(boolean), path picker (today's path field), `Field` for label/description/error, `SectionHeader` for groups.
`InputFormCard` renders `SchemaForm` from `input.schema`; the Markdown block renders `FormBlock` (same card, no Skip,
no secret). Layout: one column, label above, description under the label, error under the control, one primary button
(`submit_label` or "Submit"), Skip as a quiet button. Phone: 16px text in fields, 44px targets. Keys: Tab follows field
order; Enter submits a form without multiline fields; Ctrl/Cmd+Enter submits any. Accessibility: each control has its
`label`, `aria-describedby` = description + error, `aria-invalid` on error, the first invalid field takes focus on a
failed submit and the error count is announced through `Announcer`. States: open; submitting ("Submitting…"); refused
(errors under fields from `error.fields`); answered — collapsed summary of field titles, never values of passwords
("Password provided · Email, Keep me signed in answered"); "Skipped"; "Closed: stopped"; Markdown form "Answered" or
"Not answered" (a later request exists).

**Demo** (`demo/v7.ts`, `demo/forms.ts`): "Sign in to staging" (email + password), "Choose a region" (6 choices with
titles → Select; a 3-choice variant → segments), "Deploy settings" (replicas integer 1–10 step 1, window date-time,
"Use a canary" boolean, canary percent visible when canary is on), and a reply with the "Release checks" block.

## Part B — Mentions and tags

### B.1 Kinds and encoding

| Kind | Menu group | Encoded target | Resolved by the service to |
| --- | --- | --- | --- |
| file | Files | `octo://file/{pid}/{folder}/{path}` | folder-relative path; ACP: a `resource_link` block |
| folder | Files | `octo://folder/{pid}/{folder}/{path}` | path; ACP: `resource_link` |
| project | Projects | `octo://project/{pid}` | name, folders, Octo agent; enables `ask_project` for it |
| session | Sessions | `octo://session/{pid}/{sid}` | title, state, last request and first 500 characters of its last reply |
| agent | Agents | `octo://agent/{pid}/{agent_id}` | plugin ACP agent id (as "Use the X agent") or a sub-agent's task and result |
| note | Notes | `octo://note/{pid}/{nid}` | the note's index line; the body via `read_note` |
| request | Requests | `octo://request/{pid}/{sid}/{turn_id}` | the request text and its reply, first 500 characters each |
| tag | Tags | plain `#deploy` (no link) | the index lines of the project's notes with that tag |

Syntax: `@[label](octo://kind/…)`; `]` and `\` in the label are backslash-escaped, path segments percent-encoded.
Example request text as stored:
`Ask @[Atlas API](octo://project/prj_0001) to rename the refresh endpoint, then update
@[src/lib/session.ts](octo://file/prj_0002/orbit-app/src/lib/session.ts) here. #release`.
A `#tag` counts only when it starts with a letter, follows a space or the start, and names an existing note tag.

**To the agent.** The text goes unchanged (models read links). The service parses mentions of the request
(`internal/mentions`, Go; `ParseMentions(text) []Mention`) and adds a "Mentioned" context block to that request, never
stored, listing each resolved target (`project prj_0001 "Atlas API": use ask_project`), and "Not found" for a gone
target. ACP prompts add a `resource_link` (`uri: file://<abs path>`, `name`) per file or folder mention.

```ts
export type MentionKind = "file" | "folder" | "project" | "session" | "agent" | "note" | "request" | "tag";
export type Mention = { kind: MentionKind; label: string; uri: string; project_id?: string; start: number; end: number };
export function parseMentions(text: string): Mention[]; // agent-client, mirrors internal/mentions
```

### B.2 Composer

`@` opens the menu with groups Files, Projects, Sessions, Agents, Notes, Requests (`GET /v1/search`, this project),
then Attach and Project actions; `#` opens Tags (this project's note tags). Search filters across groups; each group
shows 5 rows, "Show all" expands one. Other projects' files are not offered (mention the project instead). Picking
inserts the token `@Atlas API ` tinted as a mention (`ComposerHighlight`); Backspace at a token's end removes it whole;
editing inside it turns it into plain text. The composer keeps `{label, uri}` per token and, on send (and on queue
edit), writes the link form; a draft restored from storage keeps the links. Pasted link syntax becomes tokens.
Placeholder: "Ask anything, @ to mention, # for a tag".

### B.3 Rendering

Request bubble (`UserPrompt`): the Markdown renderer in a `request` profile — paragraphs, soft breaks, bold, italic,
inline code, fenced code, lists, block quotes, tables, `http(s)` links (open outside), mention chips; headings render as
bold paragraphs; images render as their link text; raw HTML stays text. `octo-comments` and `octo-form-answer` blocks
are split out first (the latter as "Answered Release checks" with the field titles). Pill: one line of prose with no
block element. Replies: the same chip for `octo://` links. Chip: kind glyph + label; click opens the target (project →
its conversation, session → `#/p/<pid>/s/<sid>`, file → editor, note → Notes, request → that request in its
conversation); a gone target is a struck chip titled "No longer exists". "Copy" on a request copies the raw text.

## Part C — Cross-project requests

### C.1 The tool

```json
{"name": "ask_project", "input": {"project": "prj_0001", "request": "Rename POST /auth/refresh to POST /auth/token
 and keep the old path as an alias for one release. Reply with the new contract.", "wait": true, "timeout_minutes": 10}}
```

Input: `project` (id or exact name, case-insensitive), `request` (≤ 8 000 characters), `title?` (≤ 80; default the
request's first line), `wait?` (default `true`), `timeout_minutes?` (1–60, default 10). Result:

```json
{"status": "done", "ask_id": "ask_7f2c", "project": {"id": "prj_0001", "name": "Atlas API"},
 "session_id": "ses_91ab", "reply": "Renamed … The old path answers 308 until 2026-12-31.",
 "files_changed": [{"folder": "atlas-api", "path": "src/auth/routes.ts", "kind": "modified", "added": 14, "removed": 6}],
 "link": "octo://session/prj_0001/ses_91ab"}
```

`status`: `done | failed | stopped | needs_you | running | queued | started | denied`. `wait: false` answers `started`
at once; `wait: true` answers when the asked request ends, or at the timeout with `running`, `queued` or `needs_you`.
Whenever the call returned before the end, the final result is delivered later as a session report (`AddSessionReport`,
`from_session_id` = the `octo://session/…` link) at the asking session's next request. `reply` ≤ 4 000 characters,
redacted with both projects' secrets; `files_changed` ≤ 50; `error {code, message}` on `failed` / `denied`.

### C.2 Rules

- **Who may ask.** Allowed without a card when the target is mentioned in the request being answered (or a steering
  message of it); otherwise an approval of kind `project` — "Octo wants to ask Atlas API: <first 300 characters>",
  options Allow, Always allow asking Atlas API from this project, Deny; the rule is `{tool: "ask_project", match:
  <target id>, exact: true}` in the asking project. Denied or timed out → `denied`. Not offered to sub-agents; refused
  in `ask` and `plan` modes ("Asking another project is not available in Ask mode").
- **Chains.** The target session's origin carries `chain` (project ids); a call whose target is in the chain fails
  `ask_project_cycle`; a chain of 2 hops fails `ask_project_depth`. A project cannot ask itself (use sessions).
- **In the target.** A new main session (not the default), title "From <source>: <title>", the target project's Octo,
  mode, access, workspace (shared), memory setting and budget. Its first request is the `request` text with author
  "Octo in <source>"; the context adds one unstored line: "This request comes from Octo in project <source> on behalf
  of the person. Finish with a short summary; changed files are reported automatically." Caps apply (`queued`).
  Approvals and forms appear in that session and raise "Needs you" there.
- **Stop and loss.** Stop of the asking request stops its asks that still run (`stopSession` in the target, status
  `stopped`); stopping the target session ends the ask `stopped`; target project deleted → `failed`
  (`project_deleted`); asking project deleted → the target session keeps working, its back link reads "Source project
  deleted". After a crash, `RecoverInterrupted` marks asks whose target turn was interrupted `failed` (`interrupted`).
- **What crosses.** Only `reply`, `files_changed`, state and links; never the target's transcript, tool output,
  secrets or memory. Memory: each project records its own exchange (the asking project's holds the tool call and result).
- **Remote devices.** `/ask` needs `send`; answering a `project` approval needs `answer`; read-only devices only see.

### C.3 Direct path

`/ask @Project <text>` (new `OCTO_COMMAND_NAMES` entry; the project token is required): `POST
/v1/projects/{pid}/asks {target_project_id, text, session_id?}` → 201 `{ask, session}`; the target gets a session with
origin `by: "person"`; this conversation gets nothing; a toast "Sent to Atlas API" with "Open". A request that merely
starts with a project mention is an ordinary request to this project's Octo.

### C.4 Wire and storage

```ts
export type SessionOrigin = { by: "octo" | "person"; project_id: string; project_name: string; session_id: string;
  ask_id: string; chain: string[] };
// ProjectSession gains: origin?: SessionOrigin
export type ProjectAskStatus = "queued" | "running" | "needs_you" | "done" | "failed" | "stopped" | "denied";
export type ProjectAsk = { id: string; session_id: string; turn_id: number; by: "octo" | "person";
  target: { project_id: string; project_name: string; session_id?: string }; title: string; wait: boolean;
  status: ProjectAskStatus; reply?: string; files_changed?: FileChangeSummary[]; error?: ErrorInfo;
  created_at: string; finished_at?: string };
export type ProjectAskUpdatedEvent = { type: "project_ask.updated"; seq: number; ask: ProjectAsk };
// ApprovalKind gains "project"; Approval.detail gains target_project_id, target_project_name, request.
// Bridge: listProjectAsks(pid, {session_id?}), askProject(pid, {target_project_id, text, session_id?}), stopProjectAsk(pid, id)
```

Routes: `GET /v1/projects/{pid}/asks?session_id=` → `{asks}`; `POST /v1/projects/{pid}/asks` → 201 (404 `not_found`,
409 `ask_project_cycle`, 409 `queue_full`); `POST /v1/projects/{pid}/asks/{id}/stop` → 204. Events:
`project_ask.updated` on the asking project's stream (every status change); `session.created` with `origin` on the
target's; the target's `project.attention` as today. The harness MCP server (`octo-harness`) lists `ask_project` with
the same schema; its call blocks up to `timeout_minutes`.

Schema 16 (`migrate_v16_project_asks.go`): `sessions.origin_json TEXT NOT NULL DEFAULT ''`; table `project_asks (id
TEXT PRIMARY KEY, session_id, turn_id, by, tool_call_id, target_project_id, target_project_name, target_session_id,
title, wait, status, result_json, created_at, finished_at)` in the asking project's database; backup
`project.sqlite.pre-v16` as for 15.

### C.5 UI

Asking conversation: an ask is a delegation row like a sub-agent's (`DelegationGroup`): glyph, "Asked Atlas API ·
Rename the refresh endpoint", state ("Working", "Waiting for a free slot", "Needs you in Atlas API", "Done · 2 files",
"Failed: <message>", "Stopped", "Not allowed"), "Open session" (goes to the target session); expanded, the reply and
files. Target: the session row and header carry "From Octo in Orbit mobile" (or "From you in Orbit mobile") with a link
back; the first bubble's meta reads the same. Sidebar and Home use the existing needs-you ordering. Approval card for
kind `project`: title "Ask another project", body the request excerpt. Demo: Orbit mobile asks Atlas API, the target
session shows "From Octo in Orbit mobile", plus one ask waiting on an approval.

## 3. Phasing

| Phase | Builds | Areas and files | Criteria |
| --- | --- | --- | --- |
| A1 (M) | Schema parse, normalise, limits, `FromFields`, `CheckAnswer`; `request_input` `schema`; MCP tool schema; 400 `error.fields`; mock `[schemaform]` | harness: `internal/inputs/schema.go`, `inputs.go`, `orchestrator/secrets.go`, `bridge/inputs.go`, `mockllm/v7.go`, `fakeacp/v7.go`; docs `v7.md` §4 | 1–7 |
| A2 (L) | Client types; `SchemaForm`, `InputFormCard` on schema, answered states; demo forms | client: `types.ts`, `state.ts`; ui: `lib/forms/schema.ts`, `components/forms/*`, `components/v7/InputFormCard.tsx`, `demo/forms.ts`; script `packages/ui/scripts/schema-forms.mjs` | 8–13 |
| A3 (M) | `octo-form` blocks: render, `form_answer`, service validation and text, briefing paragraph, mock `[mdform]` | harness: `bridge` messages, `inputs`, briefing; client: `form_answer` in the options of `sendOrQueueMessage` and `sendSessionMessage`; ui: `Markdown.tsx` code renderer, `FormBlock.tsx` | 14–17 |
| A4 (S, cuttable) | Tool-server `octo_elicitation` round trip | harness: `internal/tools/remote/remote.go`, `inputs`; docs `architecture.md` | 18 |
| B1 (M) | Mention syntax (Go + TS parsers), chips, request Markdown profile | harness: `internal/mentions`; client: `mentions.ts`; ui: `Transcript.tsx` `UserPrompt`, `Markdown.tsx`, `MentionChip.tsx` | 19–22 |
| B2 (L) | `@` / `#` menu groups, tokens, serialisation; "Mentioned" context block; ACP `resource_link` | ui: `ComposerMenu.tsx`, `Composer.tsx`, `lib/mentions.ts`, `ComposerHighlight.tsx`; harness: context build, `acp` prompt | 23–27 |
| C1 (L) | `ask_project` (built-in and MCP), schema 16, approvals kind `project`, chain rules, stop, timeout, reports, recovery, routes, events; mock `[askproject:NAME]`; `scripts/e2e-asks.sh` | harness: `orchestrator/asks.go`, `projectstore/migrate_v16_project_asks.go`, `approval`, `mcp`, `bridge/asks.go`; docs `sessions.md` | 28–36 |
| C2 (M) | Client asks, ask rows, origin labels, `project` approval card, `/ask`, demo | client: `types.ts`, `client.ts`, `state.ts`; ui: `DelegationGroup.tsx`, session header, `ApprovalCard.tsx`, `lib/slash.ts`, `demo/asks.ts` | 37–40 |

Order: A1 → A2 → B1 → C1 → C2 → B2 → A3 → A4. Each phase updates this spec's "As built" and the feature page.

## 4. Acceptance criteria

Forms
1. `request_input` with the sign-in schema opens a form whose `input.requested` carries the normalised schema with
   `x-octo.order = ["email","password","remember"]`. — Go test (`inputs/schema_test.go`).
2. `request_input` with legacy `fields` answers exactly as before, and its `InputRequest` carries both `fields` and the
   converted `schema`. — Go test; `e2e-v7.sh` unchanged passes.
3. Both `fields` and `schema`, a nested object, `$ref`, 21 properties, a 33 KiB schema, or a pattern Go cannot compile
   are each refused with a tool error naming the cause. — Go table test.
4. Submitting `{email: "not-an-email"}` answers 400 `invalid_request` with `error.fields = {email: …, password: …}`, and
   neither the body nor the log contains a submitted value. — bridge test (`v7_forms_test.go`).
5. A submitted password is stored as secret `password`, appears in no transcript, event, log, usage row or GET, and
   the model's result says `use_as: "secret:password"`. — bridge test extending the existing scan.
6. A hidden field (`visible_when` false) sent in the answer is refused; omitted, it is not required. — Go test.
7. Numbers outside `minimum`/`maximum`, a non-integer for `integer`, an array outside `minItems`/`maxItems` or with a
   value outside its choices are refused; valid ones reach the model typed. — Go test.
8. The client's `validateSchema` gives the same verdict as the Go `CheckAnswer` on a shared fixture of 40 cases. —
   client test reading `packages/agent-client/src/fixtures/forms.json`; Go test reading the same file.
9. A 3-choice one-of renders as segments, a 6-choice one as a Select, a 4-item many-of as checkboxes. — UI logic test
   (`lib/forms/widgets.test.ts`).
10. On the demo, Enter in "Sign in to staging" submits; in a form with a multiline field Enter adds a line and
    Ctrl/Cmd+Enter submits. — Playwright `schema-forms.mjs`.
11. A failed submit focuses the first invalid field, sets `aria-invalid`, and announces "2 fields need attention". —
    Playwright.
12. After submit the card collapses to "Password provided · Email, Keep me signed in answered"; Skip shows "Skipped";
    Stop shows "Closed: stopped". — UI logic test (`answeredLine`) + Playwright.
13. At 390 px width every field's text is 16 px and every control is at least 44 px tall. — Playwright.
14. A reply with a valid `octo-form` block renders a form once the reply ends; a malformed one renders a code block
    with "This form could not be shown". — UI logic test (`parseFormBlock`) + Playwright on the demo.
15. Submitting a block form stores a request with an `octo-form-answer` block and starts a new request whose model
    input contains the values. — bridge test with mock `[mdform]`.
16. A block with `format: "password"` is not rendered as a form, and a `form_answer` to it answers 400. — UI test + Go test.
17. A `form_answer` for a reply that is no longer the session's last answers 409 `form_stale`; the UI shows "Not
    answered". — bridge test + Playwright.
18. A tool server answering `octo_elicitation` gets the re-invoke with `_octo_elicitation.action = "accept"` and the
    values; the stored tool result is its second answer. — Go test with an `httptest` tool server.

Mentions
19. `parseMentions` (TS) and `ParseMentions` (Go) agree on a shared fixture including escaped labels,
    percent-encoded paths, `#tag` rules and code spans (no mentions inside code). — client + Go tests.
20. A request with a project mention renders a chip "Atlas API"; clicking it opens that project's conversation. —
    Playwright on the demo.
21. A request with a list, inline code and a fenced block renders them; `# Title` renders as a bold paragraph,
    `![x](http://…)` as text, `<b>` as text. — UI logic test of the request profile + Playwright.
22. A one-line plain request is a pill; one with a code block is not. — Playwright.
23. Typing `@atl` shows Projects → "Atlas API"; Enter inserts the tinted token; sending stores
    `@[Atlas API](octo://project/prj_…)`. — Playwright + UI logic test (`serialiseTokens`).
24. Backspace at a token's end removes the whole token; typing inside it leaves plain text and sends no link. — UI logic test.
25. `#deploy` with a note tagged `deploy` adds that note's index line to the request's context report; `#123` does
    nothing. — Go test of the context build.
26. The "Mentioned" block lists each resolved target and is absent from the stored transcript. — Go test.
27. An ACP Octo's prompt for a request with a file mention carries a `resource_link` with the file's absolute
    `file://` URI. — Go test with `fakeacp` recording the prompt.

Cross-project
28. With Atlas API mentioned, `ask_project` (wait) creates a main session in Atlas API titled "From Orbit mobile: …"
    with `origin`, runs it on Atlas API's agent and folders, and returns `done` with its reply and changed files. —
    Go test + `e2e-asks.sh` (mock model `[askproject:Atlas API]`).
29. Without a mention, the call raises a `project` approval; Allow runs it; Always allow saves `{tool:"ask_project",
    match:<id>, exact:true}` and the next call raises none; Deny returns `denied`. — Go test.
30. A→B→A fails `ask_project_cycle`; a third hop fails `ask_project_depth`; asking oneself fails. — Go test.
31. Stop in the asking request stops the running target session; the ask ends `stopped` on both sides. — Go test + e2e.
32. With Atlas API's `max_running = 1` and a running session, the ask reports `queued` and later `done`. — Go test.
33. At the timeout the call returns `running`; the final result reaches the asking session's next request as a
    report, once. — Go test (short timeout).
34. A target approval sets Atlas API's `project.attention` and the asking project's `project_ask.updated` status
    `needs_you`. — bridge test.
35. Neither project's transcript, memory or events contain the other's secrets; only `reply` and `files_changed` cross.
    — bridge test scanning both projects after a run with a secret in each.
36. A database written by schema 15 opens, migrates to 16 with a `pre-v16` backup, and the previous binary refuses
    it. — `migrate_v16_test.go`.
37. The asking conversation shows "Asked Atlas API" with live state and "Open session"; the target shows "From Octo in
    Orbit mobile" with a link back. — Playwright on the demo + check against `harness serve` with the mock model.
38. `/ask @Atlas API rename it` creates the session there, toasts "Sent to Atlas API" with "Open", and adds nothing to
    this conversation. — Playwright + client test (`askProject`).
39. A read-only remote device gets 403 `remote_read_only` on `POST …/asks` and on answering a `project` approval. —
    `e2e-remote.sh` addition.
40. Deleting the target during an ask ends it `failed` (`project_deleted`) and the chip renders "No longer exists". —
    Go test + UI logic test.

## 5. Risks

- **Markdown in requests changes pasted logs** (`*`, `_`, `#` lines). Mitigation: Copy gives the raw text; soft breaks
  kept; headings never enlarge. Watch the owner's re-test.
- **Long-blocking MCP calls**: an ACP agent's MCP client may time out before 10 minutes; the result then arrives as a
  report and the agent may retry. `timeout_minutes` is the lever; `e2e-acp-orchestrator.sh` gains a case.
- **Token tracking in a plain text area** can lose a link when a token is edited mid-word; the fallback is plain text,
  which is still readable by the model.
- **Agents misusing `octo-form`** for things a question would do; the briefing says "only when the person must choose
  among options or fill several values".
- **Cross-project cost surprises**: the asked project's budget pays; the row shows that project's name and the target's
  budget stop applies. No combined cap in v1.
- **Schema 16 collision** with concurrent work (Antigravity support): renumber on merge, test both orders.

## 6. Open questions (each with the default work proceeds with)

1. Should a mention of a project in an earlier request of the same session also allow `ask_project` without a card?
   *Default: no — only the request being answered.*
2. Should `ask_project` reuse a target session the same source session asked before (follow-ups), instead of a new
   session each time? *Default: new session each time; `session_id` input reserved for a later follow-up mode.*
3. Should the asked project's changes be reviewable from the asking project's Changes? *Default: no; "Open session"
   leads to them.*
4. Should person-made forms (a command that sends a schema form to the agent) come in v2? *Default: not planned.*
5. Session and request tags (`#tag` on sessions)? *Default: deferred until a filter or search needs them.*
6. Should Markdown in requests have a per-request "Show as plain text" switch? *Default: no; Copy gives raw text.*
7. ACP has no standard elicitation yet; when it gains one, map it to the same card? *Default: yes, through
   `inputs.ParseSchema` with `source: {kind: "acp"}`, in its own change.*

## 7. Not in this spec

Real MCP elicitation (the harness has no MCP client) and URL-mode elicitation; nested or repeating form sections;
forms people author; tags on sessions or requests; mentions of other projects' files, sessions' messages or
people; a rich-text composer; cross-project file editing by the asking agent; a combined budget across projects;
coordination tools of parallel sessions phase 4 (`list_sessions`, `message_session`), which stay as specified there.

## As built

Nothing built yet.
