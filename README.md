# Commonplace

A multi-user Markdown knowledge base. Notes live in **Postgres with pgvector**,
several people can edit the same note at once with live cursors, and the web UI works on a laptop
and as a home-screen app on an iPhone. Everything imports from and exports to plain markdown, so
an exported zip is a plain folder of Markdown files that other Markdown editors open as they are.

**Documentation:**

- [Architecture](docs/ARCHITECTURE.md): how it's built, and why.
- [Principles](docs/PRINCIPLES.md): the design bar.
- [Backlog](docs/BACKLOG.md) and [Changelog](docs/CHANGELOG.md).
- [Connecting Claude over MCP](docs/MCP.md).
- [The iPhone Shortcut](docs/IPHONE-SHORTCUT.md).
- [Tests](test/README.md).
- [The standalone version](standalone/README.md): one HTML file that edits a folder of Markdown files, with no server.
- [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

## Features

- **Extended Markdown:** `[[wikilinks]]` (with `|alias` and `#heading`), `![[embeds]]` for images,
  audio, video and PDFs, `#tags` (nested, inline or in frontmatter), YAML frontmatter shown as
  properties, `> [!callouts]`, `==highlights==` and coloured text and highlights (⌘⇧H; read from Highlightr,
  Editing Toolbar and Hilo, written as HTML that other editors show), GFM tables, ```` ```mermaid ```` diagrams (the same
  syntax other Markdown editors use), and task lists you can tick in reading view.
- **Dataview queries:** ```` ```dataview ```` blocks (`TABLE`, `LIST` and `TASK`, with `FROM` a folder,
  `#tag` or `[[link]]`, `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT`, `WITHOUT ID` and Dataview's
  functions), inline `` `= expression` ``, and the common `` `$= dv.pages(…).where(…).length` `` count,
  read the way the Dataview plugin reads them, over frontmatter, inline `key:: value` fields,
  tags, links and tasks. Results show in reading view, embeds and Live Preview, follow the vault
  as it changes, and a task ticked in a `TASK` result is ticked in its own note. No code from a
  note runs: other `$=` JavaScript and `dataviewjs` blocks show as code.
- **Live Preview:** markdown renders in place while you type. Headings, bold,
  links, `[[wikilinks]]`, images, task checkboxes, callouts, quotes, code and Mermaid diagrams show formatted, and a
  line reveals its raw markdown only while the cursor is on it. Frontmatter shows as a properties
  panel you can edit in place (text, numbers, dates, checkboxes, and lists as pills; add, rename
  or remove properties), and GFM tables render as tables you edit cell by cell (Tab between cells, a bar for rows and columns), written back with the pipes lined up. Click a
  link to follow it, tick a checkbox to complete a task. As in Notion, `/` opens a menu of
  blocks, and a `+` / `⋮⋮` handle beside each block inserts below it, turns it into another kind,
  colours, duplicates or deletes it, and drags it (a list item with its children) to a new place.
  Source mode (`</>`) shows plain markdown; reading view is
  read-only.
- **Live collaboration:** Yjs CRDTs over WebSockets. Edits merge character by character, you see
  other people's cursors and selections and who is in the note, and undo only undoes your own
  changes. A phone that edits offline merges cleanly when it reconnects.
- **Multi-user vaults:** accounts and shared vaults with owner, editor and viewer roles. Viewers
  are read-only everywhere, including on the live socket. Owners invite people by email, and
  nobody joins until they accept: the invitation waits in their file panel (even if they sign up
  later) with Join vault and Decline. An admin manages accounts.
- **Types (think in things, not files):** say what a note *is* (Person, Meeting, Book) with
  `type:` in its properties. Start from a ready-made type (Person, Organisation, Meeting, Project,
  Book, Idea) or make your own; a type's note opens with a form for its properties (text, number,
  date, checkbox, list, a choice, or a link to another type), icon and colour, and its body is
  the template. Renaming a type renames it in every note. Each type has a page in the sidebar: its notes as a table, cards or a list, with
  filter, sort, group, editable cells, and views saved as a Bases (`.base`) file. A typed
  note shows its type's properties with the right editor (a relation picks a note of the right
  type), and the other side sees it: Sam's panel says "As attendees: Kickoff". Daily notes list
  what was made and changed that day. All plain, portable markdown.
- **Notes inside notes:** `![[Note]]` shows that note in place, and `![[Note#Heading]]` just that
  section, in Live Preview and reading view, three deep, with loops cut off. A link to a typed
  note on a line of its own shows as a card with its type and key properties (each type can turn
  cards off).
- **Weblinks:** a link shared from the iPhone (or ⌘K → Save a web link) becomes a Weblink note
  with the page's title, summary, site and picture, fetched safely by the server.
- **Tasks, bookmarks and mentions:** every `- [ ]` in the vault on one Tasks page (open or done,
  by note or by due date, ticked in place); bookmarks at the top of your sidebar; the side panel
  lists notes that mention this one without linking, with one-click Link; the file tree sorts by
  name, last changed or newest. Following a link to a missing note asks whether it's a plain note
  or one of your types.
- **Links:** backlinks, outgoing links (with one-tap creation of notes that don't exist yet), an
  outline, a force-directed graph view, and renames that rewrite every `[[link]]` pointing at the
  note.
- **Search:** Postgres full-text and fuzzy title search, plus pgvector semantic search over
  heading-sized chunks, fused with Reciprocal Rank Fusion. `tag:x` and `path:x` filters work, and
  a Related panel shows the notes nearest in meaning.
- **Folders:** create folders and subfolders from the sidebar, including empty ones (shared with
  every member). Drag notes and folders onto a folder, or onto empty space for the
  top level (on a phone, press and hold, then drag). Rename or move a folder with everything
  inside; an empty folder can be deleted. Empty folders survive export and import.
- **Import and export:** an existing vault folder of Markdown files, a `.zip` of one, or loose `.md` files.
  Dot-folders (app settings, `.trash/`) are skipped, and CRLF line endings and BOMs are cleaned. Exports are
  per note (`.md`) or per vault (`.zip`).
- **Version history:** a snapshot is taken every ten minutes of editing, and before every import
  overwrite and restore. An agent's or GitHub's burst of changes keeps the version before the
  first, and each note keeps its newest 100 versions.
- **Trash:** deleted notes keep their history and can be restored for 30 days.
- **Storage guard:** the database disk is a fixed size (`DB_DISK_GB`, default 1). At 80% admins
  are told; at 90% new notes, files, imports and agents' edits are refused with a message saying
  why, while typing in open notes carries on, so the disk never fills (Render suspends a full
  database). A note is at most 5 MB.
- **Backups:** `GET /api/backup` with `Authorization: Bearer $BACKUP_TOKEN` returns every vault
  as markdown plus history, members and Trash as JSON; `.github/workflows/backup.yml` (in a private repository only: anyone who can read a repository can download its artifacts) fetches it
  daily and keeps 14 days of copies as workflow artifacts. The zip is streamed, so its size
  isn't limited by the server's memory. `bun scripts/restore.ts backup.zip --owner you@example.com`
  (with `DATABASE_URL` set) restores it: notes, files, folders, history and Trash, with members
  whose accounts exist. Not in a backup, by design: passwords, AI keys and GitHub tokens, and
  GitHub vault links (a GitHub vault restores as a plain vault).
- **Bring your own AI:** add an assistant with your own Anthropic, OpenAI, relaxAI (UK
  datacentre, billed in £) or OpenAI-compatible key (`/boyai`). Every conversation shows what it
  cost in £, and each assistant has a daily £ limit (£1 unless you change it), checked before
  every call against a ledger; list prices live in `src/prices.ts`. Type `@Claude` in a note to talk to it under that line, or press `⌘J` for the
  AI side panel. It works as a librarian (searches and answers with links to your notes), an
  author (makes pages from what it finds) and an organiser (reformats, sets properties, moves,
  splits). Changes to the open note happen live and are kept in Version history; anything else
  (a new page, another note, a move) shows a diff to **Apply** or **Discard**, with Undo after.
  It can also drive the app (open a note, show the graph, hide the file panel), and it knows your
  types: it files notes into them with their properties filled in, proposes a new type when
  several notes are the same kind of thing, and merges duplicates. Keys are stored
  encrypted (`SECRETS_KEY`) and never shown again or shared.
- **Publish a vault as a website** (Settings → Website, owners): the whole vault or chosen
  folders become pages at `/p/<site>/`, with `[[links]]` between them, pictures, callouts and
  tasks (pages run no script, so a Mermaid diagram shows as its source, and Dataview results are
  worked out at Publish from the published notes only); a note with `publish: false` stays out, and a link to a note that isn't published shows
  as plain words. Publishing takes a copy, so your edits stay private until you publish again;
  Settings lists what a republish would add, change or take down. Unlisted (search engines are
  asked to leave it out), and taking it down has an Undo. The choice is kept in `publish.json`,
  so it goes with an export or a GitHub repo.
- **GitHub vaults:** open a repository of markdown (or one folder of it, such as `docs/`) as a
  vault with your own fine-grained token. Notes, pictures and canvases are copied in; code,
  app settings folders (dot-folders) and everything else stay on GitHub, untouched. Your edits are a branch: a bar at
  the top says which branch and how many notes changed, **Review changes** shows each one's diff
  against GitHub with a Revert, and **Open pull request** sends them as one commit on a new
  branch with a PR (later edits are more commits on it). **Update from main** brings in newer
  work: unchanged notes update in place, notes changed on both sides merge line by line, and a
  real clash waits for you to pick a side. **Cancel the branch** puts every note back. Nothing
  reaches `main` without a pull request.
- **Works offline:** a service worker keeps the app and what it needs to open, and every note you
  open is kept on the device (its CRDT state in IndexedDB), so the home-screen app opens with no
  signal, notes take edits, and they merge when it reconnects. Signing out forgets it all.
- **Phone-ready:** drawers instead of side panels, a formatting bar above the keyboard, safe-area
  insets, dark mode, and installable to the home screen.

## Run it

```bash
docker compose up -d db          # Postgres 18 + pgvector on localhost:5434
cp .env.example .env             # defaults work as-is
bun install
bun run dev                      # http://localhost:3000 (hot reload)
```

Or run the whole stack in Docker with `docker compose up -d --build`. It runs in production mode,
so the first account needs a setup token: the server prints one in `docker compose logs app` (or
set `SETUP_TOKEN` yourself).

The first account you create becomes the admin and gets a vault. After that, an admin adds people
under **Settings → Admin** (or set `ALLOW_SIGNUP=true` to let anyone register). Share a vault from
**Settings (⚙) → This vault → Members**: invite their email, and they join when they accept.

### On an iPhone

The server listens on all interfaces. On the same Wi-Fi, open `http://<your-mac>.local:3000`
(for example `http://my-mac.local:3000`) in Safari, then use **Share → Add to Home
Screen**. Over plain HTTP the session cookie is not marked `Secure`. Anywhere beyond your own
network, put it behind HTTPS (Caddy, Tailscale Serve, Cloudflare Tunnel) and set
`COOKIE_SECURE=true`.

### On Render

`render.yaml` is a Blueprint: a Docker web service plus Render Postgres (which has pgvector) in
Frankfurt, about $13 a month. It runs one instance, because live-editing rooms are held in memory.
Render generates `SETUP_TOKEN`; copy it from the service's **Environment** tab and enter it when you
create the first account, which becomes the admin. For bring your own AI, add `SECRETS_KEY` with
the Environment tab's **Generate** button (it encrypts people's API keys and GitHub tokens;
changing it means everyone re-enters theirs). Signup is off after that, so add people from
**Settings → Admin**.

### Embeddings

The `EMBEDDING_PROVIDER` setting picks the model. Every provider stores `vector(1024)`, so you can
switch at any time: notes re-embed in the background at the next boot.

| Provider | What it is |
|---|---|
| `relaxai` | `Mistral-7b-embedding` via relaxAI (needs `RELAX_API_KEY`): UK company and datacentre, £0.20 a million tokens. Its 4096 dims are cut to the first 1024, which keeps the ranking (measured in Longview and here). What production uses. |
| `hash` (default) | Offline feature hashing. No model, no network. Similarity means shared vocabulary, not meaning. |
| `voyage` | `voyage-4-lite` via the Voyage API (needs `VOYAGE_API_KEY`). Higher quality, US-hosted. |
| `ollama` | `mxbai-embed-large` on a local Ollama (`ollama pull mxbai-embed-large`). Private and semantic. |
| `none` | Keyword search only. |

If the embedding provider fails, search falls back to keywords and saving is never affected.

## Keyboard

| Keys | Action |
|---|---|
| `⌘O` | Quick switcher: find a note, or create it |
| `⌘K` / `⌘P` | Every command (insert, this note, create, go, vault), from one list (`web/lib/commands.ts`) |
| `⌘\` | Show or hide the file panel (the ▯\| button at the top left; the right panel has its own at the top right) |
| `/` at the start of a line | Blocks: headings, lists, to-do, quote, callout, table, code, divider, picture, template… |
| `@name` | Talk to one of your AI assistants under this line (✓ keeps it in the note as a folded callout, ✗ discards it) |
| `⌘J` | The AI side panel: a conversation that follows you between notes (✓ saves it as a note in `AI/`) |
| `⌥N` | New note |
| `⌘⇧F` | Search |
| `⌘`-click a `[[link]]` | Follow it (or tap the **Open ↗** chip that appears when the cursor is in a link) |
| `[[` and `#` | Autocomplete notes and tags |
| Paste or drop an image | Uploads it and inserts `![[attachments/…]]` |
| Picture button (phone bar, or ⋯ → Insert picture) | Pick from Photos or take one; same upload |

**Connect Claude:** Settings → Connections → Connect Claude makes an MCP token; one `claude mcp add` command
later, Claude Code can search, read and write your notes as you (`/mcp`, tools in
`src/tools.ts`). See [docs/MCP.md](docs/MCP.md).

**Share from the iPhone:** Settings → Connections → Share from iPhone makes a capture token for an Apple
Shortcut, so **Save to Commonplace** appears in every app's share sheet; links, text and photos
land as to-dos in an inbox note. Set-up steps: [docs/IPHONE-SHORTCUT.md](docs/IPHONE-SHORTCUT.md).

## How it works

```
web/ (React + CodeMirror 6)  ──REST /api──▶  src/api.ts ─▶ notes.ts ─▶ Postgres
        │                                                     │        (notes, links, chunks
        ├──WebSocket /ws/:noteId (y-websocket protocol)──▶ collab.ts   vector(1024) HNSW,
        └──SSE /api/vaults/:id/events ◀── events.ts                    revisions, attachments)
                                                  embed.ts (debounced queue) ─┘
```

- **The markdown is the source of truth.** On every save, `notes.ts` re-derives title, tags,
  frontmatter and links in the same transaction, so search and backlinks can never disagree with
  the text. Links are stored as normalised targets and resolved when queried (exact path, then
  title, then path suffix), so a link to a note that doesn't exist yet starts working the moment
  someone creates it.
- **CRDT continuity.** Each note keeps both its markdown and its Yjs state. Writes that come from
  outside the editor (REST, import, restore) are applied as a minimal diff to the live room or to
  the stored CRDT state. They never rebuild it from text, which would duplicate the text when an
  offline client reconnected.
- **Rooms** load from the database on first connect, buffer early socket messages until loaded,
  persist about a second after typing stops (at most every 4 s during continuous typing), save
  immediately when the last person leaves, and flush on shutdown.
- **One design language.** `docs/PRINCIPLES.md` sets the bar (easy, consistent, graceful; as good
  on the iPhone). The web client is laid out to keep it: `web/ui/` holds the shared pieces (the
  modal frame, menus that become action sheets on a phone, the app's own confirm, prompt and
  Undo toasts); `web/styles/tokens.css` holds every colour, type size, radius and duration, with
  one stylesheet per area beside it; `web/components/` are the screens. `test/design.test.ts`
  fails on browser dialogs or raw values outside the tokens.
- **Clients other than the browser** (the iPhone Shortcut, MCP agents, native apps later,
  PRINCIPLES.md §10) use per-person bearer tokens (`src/tokens.ts`, table `api_tokens`), stored
  hashed and scoped: a capture token can only append to its one note (`src/capture.ts`); an MCP
  token reaches every vault with the person's own roles (`src/mcp.ts`, `src/tools.ts`). Captured photos are converted in a
  short-lived child process (`src/images.ts`): HEIC to JPEG, shrunk to 2048 px, upright.
- **The in-app assistant** (`src/ai.ts`, `src/llm.ts`, `web/lib/ai.ts`) is stateless on the
  server: the browser keeps the conversation and sends it each turn, and `POST /api/ai/chat`
  streams the reply back as server-sent events. The model uses the same tools as MCP
  (`src/tools.ts`), as the person. Each write tool can preview its change; changes to the open
  note run at once, others come back as pending, with a preview, for the browser to approve.
  Tools the browser offers (opening notes, running commands from `web/lib/commands.ts`) come
  back the same way. Keys are sealed with AES-256-GCM (`src/secrets.ts`) and sent only in
  headers.
- **GitHub vaults** (`src/git.ts`, `src/github.ts`) use GitHub's REST API, never git or a
  clone URL: the Trees and Blobs endpoints read only the files that are copied in, and a push is
  blobs, then a tree on the base tree (so nothing that wasn't copied can change), a commit and a
  ref. `git_files` keeps each file's base (repo path, blob SHA, an md5 and a note's text); changes
  are worked out on request by comparing md5s with the live rows, and an added file identical to
  a deleted one counts as a move. After an update a pushed branch gets a merge commit, so the PR
  shows only your changes. Tokens are sealed like AI keys and sent only in the
  `Authorization` header.
- **Published sites** (`src/publish.ts`) are a snapshot: Publish renders the chosen notes to
  HTML and copies the files they show into `site_pages` and `site_files`, and `/p/<slug>/` is
  served from those tables alone, so a note that isn't published can't be reached by any URL.
  Pages carry no script; a note's raw HTML is cut down to a few tags without attributes, and the
  CSP allows no script and sandboxes the page. Links are relative, so the same pages can move to
  a custom domain later. The slug is random, and the site is `noindex`.
- **Security.** Passwords are hashed with argon2id. Sessions are stored server-side and the cookie
  is HttpOnly and SameSite=Lax. Mutations and WebSocket upgrades must pass a same-origin check. A
  missing vault returns 404 rather than 403, so vault existence isn't revealed. Rendered markdown
  goes through DOMPurify, and attachments are served with `nosniff` and a sandboxing CSP, so an
  uploaded SVG can't run script.

## Develop

```bash
bun run typecheck
bun test          # unit tests + an end-to-end suite that boots the server against a scratch DB
bun run test:ui   # headless-Chromium tests of the editor, file tree and Trash (needs Chrome)
bun run screens   # screenshots of the main screens, laptop and iPhone, light and dark → ./screens
bun run standalone       # the one-file version → standalone/dist/commonplace.html
bun run test:standalone  # drives that file in Chrome (no database)
```

`test:ui` finds Chrome from `CHROME_PATH`, a Playwright download, or an installed Google Chrome,
and uses its own scratch database (`commonplace_ui`).

The end-to-end suite uses its own database, `commonplace_test`, which `db/init/` creates the first
time the Postgres container starts. (On a cluster created before that, run
`docker compose exec db psql -U commonplace -c "create database commonplace_test"` once.)
It drives two users through accounts, sharing, search, import and export, history, and live
co-editing, using the stock `y-websocket` client.

`scripts/make-touch-icon.ts` regenerates the iOS home-screen icon from the same shapes as
`web/icon.svg`.

## Licence

[MIT](LICENSE).
