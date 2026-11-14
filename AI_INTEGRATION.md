# New World Local AI Integration Protocol (`v1`)

> **Interface Version**: `v1`  
> **Transport**: Localhost-only HTTP/1.1 JSON API (`http://127.0.0.1:47831/v1` by default)  
> **Runtime Mode**: 100% offline inside the New World Windows/macOS desktop app (disabled by default)

---

## 1. Architecture & Core Principles

New World runs locally on Windows and macOS using Electron (`desktop/main.cjs`) and Chromium IndexedDB (`new-world-library`). The AI bridge exposes a versioned local HTTP API without any cloud server, remote database, telemetry, or external network port:

- **Disabled by Default**: The HTTP server does not listen at all until you enable **AI 接入与权限 (AI Access & Permissions)** in New World Settings.
- **Strictly Loopback**: Binds exclusively to `127.0.0.1`, validates loopback peer addresses, verifies `Host` headers (`127.0.0.1` / `localhost` / `[::1]`) against DNS rebinding, and rejects browser cross-origin (`Origin` / `Sec-Fetch-Site`) requests.
- **Business-Layer Execution**: Every AI operation executes through New World's existing storage and domain logic (`library.ts`, `documents/store.ts`, `ideas.ts`, `schema.ts`, `text-preview.ts`), preserving backup compatibility, editor dirty-state locks, Trash recovery, and schema sanitization. Untrusted plugin code is never loaded inside the main process.
- **Per-Client Isolation**: Each configured AI receives its own unique ID and Bearer token (`nw_ai_...`). New World stores only a SHA-256 hash (`tokenHash`) and compares tokens in constant time (`crypto.timingSafeEqual`). Client-supplied identity headers are ignored; identity is bound strictly to the verified token.
- **Audit Logging**: Requests, denials, confirmation requests, user approvals/rejections, and execution outcomes are logged locally to `NewWorld-ai-audit.jsonl`.

---

## 2. Quick Start: Connecting an AI Agent

1. Open New World Desktop (`Windows` or `macOS`).
2. Open **设置 (Settings)** -> **AI 接入与权限 (AI Access & Permissions)**.
3. Enable **启用本地 AI 接入** (default port `47831`, editable `1024–65535`).
4. Enter a recognizable client name (e.g., `Claude Code`, `Codex`, `Antigravity`, or `Custom Script`) and click **添加 AI 配置**.
5. **Copy the one-time Bearer token (`nw_ai_...`) immediately**. It is shown once and never stored in plaintext or returned over any API.
6. Configure permissions (**off by default**) and work scope (**No access / Selected works / Entire library**). Changes take effect immediately.

### Authentication & Required Headers

Include the Bearer token on all `/v1/*` requests (except `GET /v1/health`):

```http
Authorization: Bearer nw_ai_<your-token>
Host: 127.0.0.1:47831
Content-Type: application/json
```

> **Note**: Do not send browser `Origin` or `Sec-Fetch-Site` headers; the local bridge rejects browser-origin requests with `403 browser_origin_forbidden`.

---

## 3. Discovering Capabilities & Current Scope

Always query `GET /v1/capabilities` after connecting to determine what permissions and library scope the user has currently granted to your token:

```bash
curl -s http://127.0.0.1:47831/v1/capabilities \
  -H "Authorization: Bearer nw_ai_..."
```

Example response (`200 OK`):

```json
{
  "ok": true,
  "apiVersion": "v1",
  "data": {
    "apiVersion": "v1",
    "client": {
      "id": "c4f1d20e-...",
      "name": "Claude Code",
      "enabled": true,
      "permissions": {
        "create": true,
        "read": true,
        "update": true,
        "delete": false
      },
      "scope": {
        "mode": "selected",
        "workIds": ["9a4b7d10-..."]
      }
    },
    "rules": {
      "humanConfirmationRequiredForDelete": true,
      "destructiveUpdateGuardActive": true,
      "localOnly": true
    },
    "endpoints": ["GET /v1/health", "GET /v1/capabilities", "..."]
  }
}
```

Unauthenticated health probe (exposes zero user data):

```bash
curl -s http://127.0.0.1:47831/v1/health
```

---

## 4. Data Model & Relationships

Understanding New World's structure ensures safe, predictable edits:

- **Libraries (`library`)**:
  - `original`: 原创库 (original novels written by the author).
  - `reference`: 续写库 (continuation writing projects and reference source works).
- **Groups / Archive State**:
  - Works can be active on the shelf (`archived: false`) or archived (`archived: true`, stored via `archivedAt`).
  - Use `GET /v1/libraries` (or `GET /v1/groups`) to inspect counts within your authorized scope, and `PATCH /v1/works/:library/:bookId` with `{ "archived": true | false }` to move works between active shelf and archive.
- **Works (`Book`: `WrittenBook` | `ImportedBook`)**:
  - **Written work** (`format: "draft"`): Editable novel project owning one or more **Editions**.
  - **Imported file** (`format: "txt" | "md" | "html" | "docx" | "epub" | ...`): Read-only imported original. If attached to a `reference` continuation work, it carries `workId` pointing to that continuation project and appears under `work.sources`.
- **Editions (`Edition`) & Chapters (`ChapterInfo` / `ChapterRecord`)**:
  - Each work owns one or more **Editions** (e.g., `草稿` / `Draft` or converted versions, `source: "blank" | "copy" | "original"`).
  - An Edition stores ordered chapter metadata (`chapters: [{ id, title }]`) and a monotonic `revision`.
  - Each Chapter stores sanitized ProseMirror/TipTap JSON content (`content`) plus its own `revision`.
- **Ideas (`Idea`)**:
  - Short writing notes that may optionally link to `{ library, bookId }`. Under `selected` scope, an AI can only access or create ideas linked directly to works in its authorized `workIds`.

### Scope Rules for Create Operations

- `scope.mode = "none"`: All reads, creates, updates, searches, and deletes are rejected (`403`).
- `scope.mode = "selected"`:
  - `POST /v1/works` (creating new top-level novels) is **forbidden (`403 create_scope_forbidden`)**.
  - Creating editions (`POST .../editions`), chapters (`POST .../chapters`), continuation sources (`POST .../sources`), and work-linked ideas (`POST /v1/ideas`) IS allowed **only inside works listed in `scope.workIds`**.
  - Copying an edition (`copyFromEditionId`) is strictly validated to belong to the **same authorized work**.
- `scope.mode = "all"`: All top-level and nested creates are permitted when `permissions.create === true`.

---

## 5. Endpoint Reference (`v1`)

All successful responses wrap payload inside `{ "ok": true, "data": ... }` (except `GET /v1/health`). Pending human confirmation returns `202 Accepted` with `{ "ok": false, "status": "pending_confirmation", "confirmationId": "...", ... }`. Errors return `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

### Libraries & Groups

| Method & Path | Perm | Description |
| :--- | :--- | :--- |
| `GET /v1/libraries` (alias `GET /v1/groups`) | `read` | Counts of active and archived works within authorized scope only. |

### Works (Novels & Projects)

| Method & Path | Perm | Description |
| :--- | :--- | :--- |
| `GET /v1/works?library=&archived=&q=` | `read` | List authorized works (`archived`: `true` \| `false` \| `all`). |
| `POST /v1/works` | `create` | Create a work in `original` or `reference` (`all` scope required). Optional `initialChapters`, `archived`, `sourceText`/`sourceName`. |
| `GET /v1/works/:library/:bookId` | `read` | Read work details, attached `sources`, and edition summaries. |
| `PATCH /v1/works/:library/:bookId` | `update` | Rename work (`title`) and/or archive/unarchive (`archived`). |
| `DELETE /v1/works/:library/:bookId` | `delete` + UI Confirm | Moves work, editions, chapters, and sources to Trash after manual UI confirmation. |

Example — Create an original novel with initial chapter:

```bash
curl -s -X POST http://127.0.0.1:47831/v1/works \
  -H "Authorization: Bearer nw_ai_..." \
  -H "Content-Type: application/json" \
  -d '{
    "library": "original",
    "title": "星海微光",
    "initialChapters": [
      { "title": "第一章 启程", "format": "markdown", "content": "夜色沉入港湾。" }
    ]
  }'
```

### Editions

| Method & Path | Perm | Description |
| :--- | :--- | :--- |
| `GET /v1/works/:library/:bookId/editions` | `read` | List editions and word totals. |
| `POST /v1/works/:library/:bookId/editions` | `create` | Create new edition (from `chapters` or `copyFromEditionId` within the same work). |
| `GET /v1/works/:library/:bookId/editions/:editionId` | `read` | Get ordered chapter directory and per-chapter word counts. |
| `DELETE /v1/works/:library/:bookId/editions/:editionId` | `delete` + UI Confirm | Move edition to Trash after manual UI confirmation. |

### Chapters

| Method & Path | Perm | Description |
| :--- | :--- | :--- |
| `GET /v1/works/:library/:bookId/editions/:editionId/chapters?offset=&limit=` | `read` | Paginated chapter list with word counts. |
| `POST /v1/works/:library/:bookId/editions/:editionId/chapters` | `create` | Create a chapter (`title`, optional `content`, `format`, `insertAfterId`, or `position`). |
| `GET /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId?format=` | `read` | Read chapter (`format`: `all` \| `markdown` \| `text` \| `html` \| `tiptap`). |
| `PUT` or `PATCH /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId` | `update` | Update `title` and/or `content` (`format`: `markdown` \| `text` \| `html` \| `tiptap`). Subject to Destructive Update Guard & open-editor dirty check. |
| `PATCH /v1/works/:library/:bookId/editions/:editionId/chapters/reorder` | `update` | Reorder chapters via `{ "chapterIds": [...] }` (exact permutation required) or `{ "chapterId": "...", "offset": -1 \| 1 }`. |
| `PUT /v1/works/:library/:bookId/editions/:editionId/chapters` | `update` | Batch update `{ "chapters": [...] }`. Dropping chapters or massive word loss triggers Destructive Update Guard. |
| `DELETE /v1/works/:library/:bookId/editions/:editionId/chapters/:chapterId` | `delete` + UI Confirm | Move chapter to Trash after manual UI confirmation. |

### Continuation Sources (`reference` Library Originals)

| Method & Path | Perm | Description |
| :--- | :--- | :--- |
| `POST /v1/works/reference/:bookId/sources` | `create` | Import/attach text or Markdown source (`fileName`, `content`) to a `reference` continuation project. |
| `GET /v1/works/:library/:bookId/sources/:sourceId` | `read` | Extract readable text from an attached continuation source (or standalone imported book when `sourceId === bookId`). |
| `DELETE /v1/works/reference/:bookId/sources/:sourceId` | `delete` + UI Confirm | Remove attached source original from continuation project (preserves manuscript editions), after manual UI confirmation. |

### Search, Stats & Ideas

| Method & Path | Perm | Description |
| :--- | :--- | :--- |
| `GET /v1/search?q=&library=&bookId=&limit=` | `read` | Search titles, chapter contents, and linked ideas strictly inside authorized scope. |
| `GET /v1/stats` | `read` | Word/chapter counts for authorized works (daily streak included only when `scope.mode === "all"`). |
| `GET /v1/ideas` | `read` | List authorized ideas. |
| `POST /v1/ideas` | `create` | Create idea (`text`, optional `work: { library, bookId }`). Required in `selected` scope. |
| `PATCH /v1/ideas/:ideaId` | `update` | Edit `text`, `work`, or `used` boolean. |
| `DELETE /v1/ideas/:ideaId` | `delete` + UI Confirm | Delete idea permanently after manual UI confirmation. |

---

## 6. Mandatory Human Confirmation & Destructive Update Guard

### Why Delete Confirmation Cannot Be Bypassed

Even when a user grants `delete: true` to an AI client:

1. Calling any `DELETE` endpoint only submits a **pending confirmation request** (`202 Accepted` with a unique `confirmationId`), bringing the New World desktop window to the foreground (`showWindow()`) and presenting a native modal confirmation dialog with exact details (AI name, action, work/edition/chapter names, chapter count, word count, countdown).
2. **Only the human user clicking Confirm (`event.isTrusted === true`) in New World's native UI window triggers execution.**
3. Each `confirmationId` and its internal execution grant are **single-use**, **bound to the exact requesting `clientId` and target fingerprint**, and **expire automatically** (60 seconds by default). Canceling, closing the dialog, timing out, or revoking permissions immediately aborts execution without changing data.
4. Any attempt by an AI client to self-confirm via API (such as calling `POST /v1/confirmations/:id/confirm` or passing `{ "confirm": true }` / `{ "force": true }` / `{ "skipConfirmation": true }`) is **rejected or ignored**, logged in the audit trail, and never substitutes for manual UI confirmation.
5. Pass `?wait=true` on a `DELETE` or destructive `PUT`/`PATCH` URL if your client prefers blocking up to the confirmation timeout (`200 OK` if approved, `403 confirmation_rejected` if canceled, `408 confirmation_timed_out` if expired) instead of polling `GET /v1/confirmations/:id`.

### Anti-Bypass Protections on `Update` Operations

New World inspects actual content impact, not just HTTP method names:

- **Single-Step Wipe / Massive Reduction**: Clearing a chapter (`beforeWords >= 5 && afterWords === 0`), reducing a chapter to a stub (`beforeWords >= 20 && afterWords <= 3`), or losing `>= 50%` (and `>= 80` words) in one update triggers the **Destructive Update Guard**.
- **Cumulative Slow-Drip Nibbling**: New World tracks per-client session word baselines (`chapterBaselines`); splitting deletions into multiple smaller edits (`>= 100` words and `>= 65%` lost from peak) triggers the guard once cumulative loss crosses threshold.
- **Reorder & Batch Omission**: `chapters.reorder` rejects any ID list that omits, duplicates, or injects chapter IDs (`400 invalid_chapter_reorder`). `chapters.replaceBatch` treats omitted chapters or massive word loss as destructive.
- **Enforcement**: If `permissions.delete === false`, destructive updates are immediately rejected (`403 destructive_update_forbidden`). If `permissions.delete === true`, they require the same mandatory human confirmation modal as explicit `DELETE` requests.

---

## 7. Error Handling Reference

| HTTP Status | `error.code` | Meaning / Recommended AI Action |
| :--- | :--- | :--- |
| `400` | `invalid_chapter_reorder` / `invalid_*` | Malformed input or invalid ID permutation; inspect error message and correct payload. |
| `401` | `unauthorized` | Missing or invalid Bearer token. |
| `403` | `client_disabled` | This AI client configuration is disabled in Settings. |
| `403` | `permission_denied` | Required CRUD permission (`create`/`read`/`update`/`delete`) is not granted. Inform the user rather than retrying. |
| `403` | `forbidden_scope` / `create_scope_forbidden` | Target work or operation is outside authorized scope. Do not guess or probe IDs. |
| `403` | `destructive_update_forbidden` | Requested update would wipe/massively shrink text without `delete` permission. Keep existing content or write incremental edits instead. |
| `403` | `api_confirmation_forbidden` | API self-confirmation is forbidden. Ask the user to respond in the New World window. |
| `403` | `confirmation_rejected` | User declined the confirmation dialog (or permission was revoked). |
| `408` | `confirmation_timed_out` | Confirmation window expired before user responded; nothing was deleted. |
| `409` | `chapter_dirty_in_editor` | User has unsaved typing in the active editor for this chapter; ask user to save or pause editing. |
| `409` | `stale_confirmation_target` | Content changed between confirmation request and user click; re-read before trying again. |
| `503` | `ai_disabled` / `renderer_unavailable` | AI integration is disabled in Settings or desktop window is closed. |

---

## 8. Security Rules & Honest OS-Level Trust Boundaries

### Rules Every AI Adapter Must Respect

1. **Use only the HTTP `/v1` interface** on `127.0.0.1:<port>`.
2. **Never read or modify** Chromium `IndexedDB`, `Local Storage`, `NewWorld-ai.json`, `NewWorld-ai-audit.jsonl`, or backup `.zip` files directly from the filesystem.
3. **Never attempt** UI automation, AppleScript/Win32 synthetic clicks, or DOM injection to approve confirmation dialogs on the user's behalf.
4. **Never exfiltrate** novel text, tokens, or metadata to external network endpoints.

### Security Boundary Disclosure for Full-Permission Local Agents

> **Important Security Reality**: Prompt instructions are usage guidance, **not a security boundary**. While New World enforces authentication, CRUD permissions, work scoping, destructive-update guards, and human delete confirmation rigorously inside its own application processes (`desktop/main.cjs` and the renderer execution layer), **application-level controls cannot create operating-system isolation against a local agent that already holds unrestricted OS shell or filesystem permissions on the same user account**. If an agent can read/write your OS user profile (`%APPDATA%\NewWorld` or `~/Library/Application Support/NewWorld`) or run arbitrary OS commands, New World alone cannot physically prevent OS-level bypasses. When stronger isolation is required, run the agent under a dedicated restricted OS account or container with filesystem isolation, exposing only `http://127.0.0.1:<port>/v1`.

---

## 9. Adapter Development Guide (e.g., MCP Stdio Tool Wrapper)

To connect tool-calling agents (Antigravity, Claude Code, Codex, or custom MCP hosts) to New World, build a thin **stateless adapter** that forwards tool calls to `http://127.0.0.1:<port>/v1` without bundling any database driver or secret storage:

```js
// Minimal local adapter helper (Node 20+)
const BASE_URL = process.env.NEW_WORLD_URL || 'http://127.0.0.1:47831/v1'
const TOKEN = process.env.NEW_WORLD_AI_TOKEN // Bearer nw_ai_...

export async function callNewWorld(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  return { status: res.status, ...json }
}
```

Recommended adapter patterns:
- Call `GET /v1/capabilities` at session startup so your tool manifest or system context reflects actual allowed actions.
- When `status === 202` (`pending_confirmation`), immediately surface the `impact.summary` and `expiresAt` to the user and ask them to click confirm/reject in the New World window, then poll `GET /v1/confirmations/:confirmationId` (or use `?wait=true` with sufficient HTTP client timeout).
- Never retry `403` / `408` confirmation denials in a loop.

---

## 10. Copyable Prompt for Other AI Assistants

> **Reminder**: Copy this prompt to instruct another local AI assistant how to work cleanly with New World. All real access boundaries remain enforced by New World itself, not by this prompt.

```markdown
You are connected to the local New World desktop novel manager via its local HTTP `v1` API (`http://127.0.0.1:47831/v1`) using the provided Bearer token in `Authorization: Bearer ...`.

Follow these operating rules strictly:
1. Start by calling `GET /v1/capabilities` to inspect your granted permissions (`create`, `read`, `update`, `delete`) and authorized scope (`none`, `selected`, `all`, and `workIds`).
2. Operate strictly through the `/v1` HTTP API endpoints. Never inspect or modify New World's IndexedDB, Electron userData files, configuration files (`NewWorld-ai.json`), or backup archives on disk.
3. Respect New World's data model: `original` holds original novels, `reference` holds continuation writing projects (`WrittenBook`) and their attached source files (`sources`), each work contains `editions`, and each edition contains ordered `chapters`.
4. Read existing chapters before editing so you preserve tone, continuity, and user formatting (`markdown`, `text`, `html`, or `tiptap`).
5. Never clear chapters, empty books, omit chapters during reorders, or overwrite unsaved user edits (`409 chapter_dirty_in_editor`). Make incremental, non-destructive edits unless the user explicitly requested a major rewrite or deletion.
6. Whenever an operation returns `202 pending_confirmation` (for any delete or massive content reduction), explain the exact impact to the user and wait for them to click Confirm in the New World window—do not attempt to automate UI clicks or bypass confirmation.
7. If you receive `403 permission_denied` or `403 forbidden_scope`, stop that action immediately and tell the user which permission or work scope is missing in New World Settings.
```
