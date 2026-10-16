# Changelog

What's been finished, newest first, with the date and the release or commit. What's next is in
[BACKLOG.md](BACKLOG.md); finished designs are in [design/](design/). Releases on GitHub carry the
same notes.

- **2026-10-16** — Dataview queries (release v0.0.38; `src/dataview.ts`), in the app, the
  standalone version and published sites: ```` ```dataview ```` blocks with `TABLE`, `LIST` and
  `TASK`, `FROM` folders, tags and links, `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT` and
  Dataview's functions; inline `` `= expressions` ``; and the `` `$= dv.pages(…).where(…).length` ``
  counts, translated rather than run. Results show in reading view, embeds and Live Preview, refresh
  as notes change, and a task ticked in a result is ticked in its note. The app runs queries on the
  server over a per-vault cache that rereads only changed notes; the standalone file runs them in
  the browser; Publish works them out from published notes only and freezes them into the page.
  Checked against a 3,500-note vault: all 489 blocks and 91 of its 92 inline expressions run (the
  other has a stray bracket), median 104 ms to open a note with its results. No note code runs:
  `dataviewjs` and other `$=` JavaScript show as code; CALENDAR isn't supported yet.
- **2026-10-16** — Mermaid diagrams (release v0.0.37; `web/lib/mermaid.ts`), in the app and the
  standalone version, with the syntax other Markdown editors use: a ```` ```mermaid ```` block draws
  in reading view, in embeds, and in Live Preview off the cursor (a click shows the source). It
  follows light and dark, `%%{init}%%` directives work, and `class A internal-link` makes a node
  open the note it names; a diagram that doesn't parse shows the error above its source. Mermaid
  loads only for a note with a diagram (served at `/vendor/mermaid.js`, or packed inside the
  standalone file, now 2.4 MB). Strict mode, sanitised SVG and a shadow root per diagram keep it
  from running script or restyling the app. Published sites show the source, as their pages run
  no script.
- **2026-10-16** — The standalone version is fast on a large folder (release v0.0.36). On a
  folder shaped like a 3,500-note vault, a keystroke took 7.6 s and now takes one frame, opening
  takes 0.5 s instead of 4.9 s, and switching notes is instant instead of 3.8 s. Link lookups
  (`web/lib/links.ts: resolveLocal`) use an index built once per note list instead of scanning
  every note, which speeds up the full app's Live Preview and links too. Typing no longer
  rebuilds the note list unless tags, type or aliases change; notes are read in parallel; the
  preview and search follow just behind typing. `test/ui/standalone.ui.ts` checks a folder that
  size.
- **2026-10-16** — A standalone version (release v0.0.35; `standalone/`, `bun run standalone`): Commonplace as one
  HTML file that edits a folder of Markdown files with no server or account. It reuses the app's
  editor (Live Preview and the other three modes, wikilinks, embeds, tables, properties), the file
  panel, search, tags, backlinks and outline, and ⌘O. Chrome and Edge save to the files as you
  type; Safari and Firefox keep edits in the tab and download them as a zip.
- **2026-10-15** — The review's remaining findings (release v0.0.34, N13). Being added to a
  vault is now an invitation to accept (Join vault / Decline in the sidebar; owners see and cancel
  pending ones), which grants nothing until accepted, and the reply no longer says whether an
  email has an account. Outgoing fetches (weblinks, assistants) connect to the address that was
  checked, so DNS rebinding can't swap in a private one (`src/egress.ts`). The app sends a CSP
  (no inline script), `frame-ancestors 'none'`, Referrer-Policy, nosniff and HSTS. Offline copies
  are kept per person, and someone else signing in on the same browser clears the last person's.
  Only an owner deletes from Trash for good. The Docker image is pinned and runs as non-root.
  In the app: search shows its errors and can't be repopulated after clearing, vault switches
  can't mix vaults' bookmarks, saved searches or types, the links panel resets per note, folders
  and the title work from the keyboard, the quick switcher and command palette use the shared
  dialog (focus trap and return), and the error screen says what to do. Tests wait on conditions
  instead of fixed sleeps, the HEIC test runs everywhere (a fixture), and each suite has its own
  ports so they can run at once.

- **2026-10-15** — Ready for public review (release v0.0.33). A high-level design
  (`docs/ARCHITECTURE.md`: context, components, data model, key flows, security model, decisions),
  `SECURITY.md`, `CONTRIBUTING.md`, `test/README.md` and an MIT licence; a header on every file and
  a comment on every table; dead code removed; the product described in its own words. Fixes from a
  security review: the private-address check sees IPv4 written inside IPv6 (and guards assistants'
  base URLs too); the assistant asks before changing even the open note once a conversation has
  used another vault; sign-in pauses after ten wrong passwords and a new password signs out other
  devices; signup is off unless set, and production without `SETUP_TOKEN` makes one; zip imports
  expand to at most 256 MB and pass the storage guard; only owners can import `publish.json`; MCP
  batches are capped. The rest followed in v0.0.34 (N13, above).

- **2026-10-13** — Publish a vault as a website (release v0.0.32, F18 step 1). Settings →
  Website (owners): the whole vault or chosen folders, `publish: false` to keep a note out, a
  "what will be public" list, Publish, and "Take the site down" with Undo. Pages live at
  `/p/<random slug>/`, unlisted (`noindex`), in one reading theme from the app's tokens, light
  and dark, with a page list and a top-level `index`/`Home`/`README` note as the home page.
  Publish takes a snapshot (`site_pages`, `site_files`), so edits stay private until the next
  Publish, and Settings lists what a republish would add, change or take down. The tests show a
  note left out, its title and its files can't be reached by any URL, that pages run no script,
  and that the pages pass axe on the laptop and iPhone in both themes (which also fixed callout
  title contrast in the app). The choice is `publish.json` at the vault's top level.

- **2026-10-13** — Links by alias and id (release v0.0.31, F9 step 1 in part): a note's
  `aliases` (a list or one string) and AI-XF `id` are other names a link can
  use, so `[[Sam]]` reaches a note with `aliases: [Sam]` in backlinks, the graph, type pages,
  link resolution and the editor. A real title or path still wins. Kept as a generated column
  (`notes.link_names`, from the frontmatter), so the markdown stays the source.

- **2026-10-13** — A short tour (release v0.0.30, first-run welcome): an empty vault's home
  offers "Add a short tour", five ordinary notes in `Tour/` (`src/tour.ts`) that teach
  Commonplace by being used: properties, ⌘O, ⌘K, `/`, links and backlinks, an embed, a typed
  note (with the Person type, added if missing), focus mode and history. Opt-in, once per
  vault, and deleted like any folder.

- **2026-10-13** — Turn into a typed note (release v0.0.29, from Capacities): select text, or
  put the cursor on a line, then ⌘K "Turn into a typed note…" (or ⋮⋮ → "Make it a note of a
  type…"), pick a type, and the text becomes a note of that type with a `[[link]]` left in
  its place; list and to-do markup stay. An existing note of that name is linked rather than
  made twice.

- **2026-10-13** — Writing: history diff, saved searches, focus mode (release v0.0.28).
  **History** shows what restoring a version would change, as a diff against the note now
  ("Restoring brings back 1 line and takes away 2"), or its full text. **Saved searches**:
  Save in the Search panel keeps a search in the sidebar under Bookmarks, run afresh each time
  (a smart folder); per person, like bookmarks (`saved_searches`). **Focus mode** (⌘K "Focus
  mode"): only the text, at reading width, with typewriter scrolling; Escape or Leave focus
  ends it, and it's remembered on the device. Tests: 4 new UI tests, 1 e2e.

- **2026-10-13** — Accessibility (release v0.0.27, part of N12): axe runs in the UI tests on
  the main screens, laptop and iPhone, light and dark, and passes; a new keyboard-only test
  covers find, edit, Settings and back. Fixed: text contrast (`--faint`, `--accent`,
  `--danger` darkened just enough for 4.5:1), accessible names (editor, task checkboxes,
  property inputs, member role), the view switch as a radio group, the palette and quick
  switcher as a combobox with a listbox, a focus trap in every dialog, and focus landing in
  the note's text (below its properties) when it's opened from the keyboard. Also fixed:
  `fuzzyScore`'s "no match" could be outscored by a bonus, so the palette, quick switcher, `/`
  menu and choice dialogs never filtered anything out; and the palette now matches each word in
  any order ("account settings").

- **2026-10-13** — Speed at 10,000 notes (release v0.0.26, part of N12): `bun run bench` builds
  a 10,000-note vault and checks each endpoint against a budget. Fixed what it found: type pages
  (32 s → 13 ms) and the graph (failed → 150 ms) now resolve links with an equality join over
  each note's link names (`notes.linkKeys`) instead of a suffix test against every note; backlinks
  use it too. Imports, GitHub copies and restores refresh Postgres's statistics every 1,000
  notes, and new indexes on lower(path) and lower(title) keep lookups indexed: importing 10,000
  notes went from 61 s to 12 s.

- **2026-10-13** — Backups you can restore (release v0.0.25): `/api/backup` now streams the
  zip a piece at a time (a 472 MB backup peaked at 315 MB of server memory, which had 148 MB at
  rest), and `scripts/restore.ts` restores one into an empty database: notes, files, empty
  folders, history, Trash and members whose accounts exist. A new e2e test restores a backup
  and compares it note for note. Also: the boot-time schema now retries if it deadlocks with a
  server still writing (as the old instance can during a deploy).
- **2026-10-13** — GitHub vaults against real GitHub (release v0.0.24, N11): a scripted trial
  on a real private repo passed every step. Fixed what it found: a pull request GitHub refuses
  after the branch is pushed no longer strands the vault (the branch is recorded first, and
  Open pull request tries again). GitHub's refusals are logged without the token, and push
  errors stay in the dialog.

- **2026-10-12** — N9 storage guard, instead of storage autoscaling (release v0.0.23): the
  database disk stays a fixed 1 GB with autoscaling off on purpose, and the server guards it
  (`src/storage.ts`). At 80% admins see a warning when they open Commonplace; at 90% new notes,
  files, imports, GitHub copies and agents' edits are refused with a 507 that says why, while
  typing in open notes carries on, so the disk never fills (Render suspends a full database).
  Agents and GitHub syncs now keep one version per ten-minute burst rather than one per call,
  each note keeps its newest 100 versions (pruned at boot and every six hours), and a note is
  at most 5 MB however it's written. `DB_DISK_GB` defaults to 1. Tests: 3 new (176 in all).
  Also: the backlog was taken stock of and restructured (finished designs in `docs/design/`,
  this changelog split out, F9 rewritten around F16, a decided order for Next).

- **2026-10-12** — F17 one Settings screen (release v0.0.22): Account and Vault settings are
  now one **Settings** screen (`web/components/Settings.tsx`) with sections Account, This vault,
  AI assistants, Connections (Claude, GitHub, Share from iPhone) and Admin (admins only). On a
  laptop the sections are listed beside the open one; on the iPhone the list comes first and a
  section opens in its place, with a way back. The gear opens This vault, the account button
  Account, and ⌘K has one command per section ("github token", "members", "api key" find them).
  `openSettings()` (`web/lib/settings.ts`) opens it from anywhere: "New vault from GitHub" no
  longer carries its own copy of the connect form but opens Settings → Connections over the
  dialog, which carries on once connected. The rule and a checklist line are in
  [PRINCIPLES.md](PRINCIPLES.md) §2; server messages and docs now say "Settings → …". The audit
  found nothing else to move: the remaining controls (sort, edit or read mode, panels, task
  and graph filters, the AI panel's assistant) change the view, and type definitions are
  markdown. Also fixed: the vault home could say "This vault is empty" for a moment before its
  notes and folders arrived. Tests: 3 new UI tests (62 in all).

- **2026-10-12** — F14 GitHub vaults, all four steps (release v0.0.21):
  - **Copy in:** from the vault picker ("New vault from GitHub…") or ⌘K. Connect a fine-grained
    token (Account → GitHub: checked with GitHub, sealed with `SECRETS_KEY`, shown only as its
    last four characters), then pick a repo, branch and folder; the folder list shows how many
    notes each holds. Only markdown, canvases and attachments come in (not dot-folders), within
    the import limits. It reads through the Trees and Blobs APIs rather than the zipball, so a
    big code repo with a small `docs/` costs only the docs.
  - **The bar and Review changes:** the bar shows the branch, "N notes changed", any clashes and
    the PR's state, on the laptop and the iPhone. Review changes lists notes and files that were
    added, edited, moved (an added file identical to a deleted one) or deleted, each with a diff
    against GitHub (the AI chat's diff, now `web/ui/Diff.tsx`) and Revert.
  - **Pull request:** the form is filled in from the changed notes. Co-authors (others who edited
    them) appear as `Co-authored-by:` lines you can see and remove before sending. The push is
    one commit (blobs, a tree on the base tree, a commit and a ref) and opens the PR. Later edits
    show as "Push N more changes" and land on the same PR. The PR's state is checked at most
    once a minute.
  - **Update from main:** files unchanged here update in place; notes changed on both sides
    merge line by line (`src/merge3.ts`, diff3); real clashes keep your text and wait under "To
    settle" with Keep mine or Take main's (and block pushing until settled). On a pushed branch
    the next push is a merge commit, so the PR shows only your changes. After the PR is merged,
    the update ends the branch.
  - **Cancel the branch:** a confirmation names how many changes go back. Every note returns
    through `overwriteContent` (reason `github-revert`, so its edits stay in history), added
    notes go to Trash, and the pushed branch is deleted unless a PR is open.
  - **Tests:** 9 end-to-end tests against `test/fakeGitHub.ts` (an in-memory git with real blob
    SHAs, which also proves the token is never in a URL), 6 merge unit tests, and 3 browser tests.
  - **Also:** the capture token now defaults to the vault you're in, and the screenshot script
    uses a fresh browser per device and theme.
- **2026-10-12** — F12 step 2, the `+` and `⋮⋮` block handle (release v0.0.20):
  `web/lib/blocks.ts` works out blocks from the syntax tree each time (a list item with its
  children, a heading's line, a paragraph, a table, a code block, a quote or callout).
  `web/lib/blockHandle.ts` draws the handle.
  - **Where it shows:** on a laptop it follows the pointer in the left margin, which is now 52px
    there; reading view matches, so nothing jumps. On the phone just the ⋮⋮ sits by the
    cursor's block.
  - **`+`:** adds a line below (a new item in a list) with the `/` menu open.
  - **⋮⋮ menu:** Turn into… (text, headings, lists, to-do, quote, callout), Colour…, Duplicate,
    Copy link to heading, and Delete with Undo, which puts the text back where it was even if
    the note changed since.
  - **Drag:** moves the whole block with a drop line, reindenting a list item to the level it
    joins and keeping one blank line between paragraphs. A mouse drag starts after 5px, a finger
    after a 400ms press. A move is one change, so one ⌘Z puts it back. It's refused while
    another person's cursor is inside the block.
  - **Shared code:** `menuAt()` in `web/ui/Menu.tsx` opens the shared menu from outside React.
  - **Tests:** 12 unit tests, plus three browser tests: a drag while someone else types, then
    Undo; `+` with Turn into and Delete; a long-press drag on the phone.
- **2026-10-12** — F10 coloured text and highlights (release v0.0.19):
  - **Reading:** every form people's notes carry: Highlightr's `<mark style="background: #…A6;">`
    and `<mark class="hltr-…">` (checked in its source), Editing Toolbar's `<font color>` and
    `<span style="background:">` (checked in its source), hand-written `<span style="color">`,
    and Hilo's `=={red}…==`. They show in reading view and in Live Preview, where the tags hide
    off the cursor's line.
  - **Safety:** the sanitiser still forbids `style`; a hook keeps only `color` and `background`,
    only on span, mark and font, and only plain colour values. A test proves an overlay or
    `url()` can't get through.
  - **Theme-aware:** palette colours (and Highlightr's defaults) are drawn with shades for light
    and dark from tokens.
  - **Writing:** ⌘⇧H, ⌘K → Colour…, or the phone bar's **A** colours the selection (or the word
    at the cursor) as a highlight or text in six colours, or removes colour. It writes
    Highlightr's `<mark style="background">` and `<span style="color">`, which other Markdown
    editors show with no plugin.
- **2026-10-11** — F8 tables cell by cell (release v0.0.18): in Live Preview each cell edits in
  place (its markdown while editing, rendered otherwise); Tab and Shift-Tab move, Enter goes
  down, Tab or Enter at the end adds a row; a bar over the table adds rows and columns either
  side, deletes them, aligns a column and opens the markdown. Every change rewrites the table
  with aligned pipes (wide characters counted, `|` escaped) as one minimal edit, so it merges
  with live typing and one Undo reverses it; what's being typed in a cell is folded into a row or
  column change, never lost. Also: the server's shutdown flush is capped at 10 s (Render kills a
  slow process at 30 s), and the browser tests restart headless Chrome every 20 pages, which
  stops painting after forty-odd in one run.
- **2026-10-11** — Weblinks as notes (release v0.0.17, from Capacities): a link shared from the
  iPhone, or saved with ⌘K → Save a web link, becomes a Weblink note (a starter type, added on
  first use) with the page's Open Graph title, description, site and picture (saved as an
  attachment), and the inbox to-do links to it. The address kept is where the link leads after
  redirects, and saving it again finds the same note. Safe fetching (`src/weblinks.ts`): http(s)
  on ports 80/443 only; private, loopback, link-local (cloud metadata), CGNAT and unique-local
  addresses refused, re-checked at every redirect; 8 s, 1.5 MB HTML, 5 MB picture. Checked live:
  BBC News and GitHub save with pictures; 169.254.169.254 and 10.0.0.1 are refused.
- **2026-10-11** — Small wins (release v0.0.16):
  - **Tasks:** every `- [ ]` in the vault (not in code or frontmatter), open, done or all, by
    note or by due date (`📅 YYYY-MM-DD`, with overdue in red); ticking one ticks its line,
    merged with typing, and refuses if the line has changed.
  - **Unlinked mentions:** notes that say a note's title as a whole word, outside links and
    code, with one-click Link that keeps the words written (`[[Boiler|boiler]]`). After
    Capacities' "related content".
  - **Bookmarks (F7):** per person, from ⋯ or ⌘K, at the top of the sidebar beside Tasks.
  - **Sorting (F7):** the file tree sorts by name, last changed or newest.
  - **Create as a type:** following a link to a missing note asks "A note, or a Person…" when
    the vault has types.
- **2026-10-11** — F16 step 6, the AI organiser knows types (release v0.0.15):
  - **New tools** (also on MCP): `list_types`; `set_type`, which checks choices against the
    type's options and requires links to be `[[wikilinks]]`; `create_type`; and `merge_notes`,
    which folds the duplicate's text and missing properties in, relinks every note, and sends
    the duplicate to Trash. Each previews its change.
  - **Approval:** typing the open note applies at once; anything else waits for approval.
  - **Instructions:** the assistant's instructions list the vault's types and properties, with
    rules not to invent values and to leave a property out when the note doesn't say.
  - **Tried on relaxAI's DeepSeek-V4-Pro:** asked to file a six-note inbox, it read each note,
    proposed Dune as a Book (author, Read, rating 5), Sam as a Person (Trade, phone) and Shah
    Interiors as an Organisation, and suggested a Recipe type for the three bakes, all waiting
    for approval; £0.012.
- **2026-10-11** — F2 notes inside notes, with F16 step 5 link cards (release v0.0.14):
  - **Embeds:** `![[Note]]` shows the note, and `![[Note#Heading]]` just that section, in a framed
    box whose title opens it, in Live Preview (a block widget; click it to edit the line) and in
    reading view. They nest three deep; a loop says "Already shown above"; a missing note or
    heading says so. Tasks inside an embed are shown, not ticked.
  - **Link cards:** a `[[link]]` alone on its line, to a typed note, shows the type's icon and
    colour, the title and up to three of its properties. Inline links and untyped notes stay
    links. A type can turn cards off (`cards: false`, a checkbox in the type editor).
  - **AI:** `split_note` now leaves an embed, so the original still reads in full.
  - **Fixed:** after six full page loads, the seventh could stall, because the back/forward
    cache kept event streams open and used up the browser's six connections to the site. Streams
    now close on `pagehide`, and a restored page reloads.
- **2026-10-11** — F4 works offline on the iPhone (release v0.0.13):
  - **The app opens with no signal:** a service worker (`web/sw.js`) is network first for
    everything, with a cached copy of the app and the reads it needs to start (session, vaults,
    note lists, note metadata, types, pictures). It never caches writes, the event stream, AI,
    search or exports.
  - **Notes open and take edits offline:** every opened note keeps its Yjs state on the device
    (`y-indexeddb`, the 200 most recent), and is editable as soon as that copy loads, server or
    not. Edits merge when the socket reconnects.
  - **Copies can't merge with the wrong note:** they're named with this database's `instance`
    id (`server_info`), so a replaced database never merges with them.
  - "You're offline" and "Back online" toasts, and an Offline badge in the sidebar.
  - Signing out forgets the copies and the cached reads.
  - Tested by stopping the server: the app opened from the device, took an edit, kept it across a
    reload, and synced it once the server came back, with no duplicated text.
  - Not yet: creating, renaming or moving notes offline (they say the server can't be reached).
- **2026-10-11** — F16 type editor and starter types (release v0.0.12):
  - **Type editor:** a type's own note opens with a form: icon, colour, and its properties (name,
    kind, choices for a Choice, target type and "more than one" for a link), reordered or removed
    with Undo. Each change saves on its own and merges with live typing (`PUT …/types/:name`),
    keeping the template and any other keys. Renaming a property offers to rename it in the
    notes that have it.
  - **Renaming a type** (`POST …/rename`) carries every note's `type:`, other types' links to it,
    and its saved views with it.
  - **Starters:** New type offers Person, Organisation, Meeting, Project, Book and Idea, each with
    sensible properties and a template. Adding one also adds the starters its links need.
- **2026-10-11** — F16 types, steps 1–4 (release v0.0.11), after Capacities:
  - **Format:** a type is a note in `Types/` (properties, icon, colour, and its body as the
    template); a note is typed by `type:` in any common form; relations are wikilinks in
    properties, so they're ordinary links. `notes.type_name` is a generated, indexed column.
  - **Sidebar and chip:** a Types section above Folders (with types notes use but nobody has
    defined yet, to "Define it"). A chip above each title opens the type's page or changes the
    type, keeping every property.
  - **Properties panel:** shows the type's properties even when empty, with a menu for selects, a
    picker of the right type's notes for relations, and a type menu.
  - **Type pages:** table, cards or list; filter, sort, group; Recent, Untagged and No backlinks;
    cells set properties live-safe (`PATCH …/properties`); "New Person" uses the template; views
    are saved as `Types/Person.base` (a subset of the `.base` format) and export with the vault.
  - **Relations from the other side:** backlinks grouped by property ("As attendees").
  - **Days thread themselves:** a daily note lists what was made and changed that day, and every
    note links to the day it was made.
  - Lists by default on a phone.
- **2026-10-11** — F5 semantic search with relaxAI (release v0.0.10): `EMBEDDING_PROVIDER=relaxai`
  embeds with `Mistral-7b-embedding` (UK datacentre, £0.20/M), cut from 4096 to 1024 dims and
  renormalised (Longview's measurement, re-checked here: same best match at both widths).
  relaxAI's similarities are bunched, so its search floor is 0.6 *and* within 0.04 of the best
  hit, and Related needs 0.75. Measured on a real vault with the live API: meaning-only queries
  ("keeping the house warm", "travel plans") found the right note, and Related paired Boiler
  with Central heating service, not with Pancakes. Search and Related only compare vectors from
  the current provider, so results stay right while a switch re-embeds. Chose relaxAI over the
  planned Voyage to keep everything UK-hosted, as in Longview.
- **2026-10-11** — AI costs in £ and a daily £ limit (release v0.0.9), for every provider:
  `src/prices.ts` holds list prices checked 2026-10-11 (relaxAI in £; Anthropic and OpenAI in $
  at 0.75), counting prompt-cache reads at a tenth and writes at 1.25×. Each assistant has a
  price (the list price, or its own) and a daily limit (£1 by default); every model call is
  recorded in `ai_usage` and the limit is checked before each one, so a turn stops cleanly when
  it's reached and nothing more goes to the provider until the next day (London time) or the
  limit is raised. A limit needs a price, so unknown models must be given one. The cost line
  shows £; it turns amber at 80% of the limit. OpenAI's default model moved to gpt-6.1-sol.
- **2026-10-11** — relaxAI as a named provider (release v0.0.8), as Longview uses it: Civo's UK
  datacentre, OpenAI-compatible, default DeepSeek-V4-Pro (Nemotron-3-Super and
  DeepSeek-V41-Flash offered). 32k max_tokens for its reasoning models; conversation cost shown
  in £ from Longview's price table. Checked against the live API on 2026-10-11: streamed tool
  calls and tool-result round trips work on all four chat models; Kimi-K26 still answers but is
  no longer listed.
- **2026-10-11** — F13 bring your own AI (release v0.0.7): `/boyai` (or ⌘K, Account → AI
  assistants) adds an assistant with your own key: Anthropic, OpenAI, or any OpenAI-compatible
  base URL. Keys sealed with AES-256-GCM under `SECRETS_KEY`, never returned or shared, sent only
  in headers. **`@name`** in a note opens the chat under that line (a bottom sheet on the
  iPhone); ✓ keeps it as a folded `> [!ai]-` callout, ✗ discards. **⌘J** (or the side panel's
  AI tab, opened with F15's top-right toggle) is a conversation that follows you between notes;
  ✓ saves it to `AI/`. Librarian, author and organiser: new tools `rewrite_note`,
  `set_properties`, `move_note`, `split_note` (also on MCP). Changes to the open note apply live
  (merged with typing, kept in Version history); anything else returns as a pending change with
  a line diff to **Apply** or **Discard**, and every applied change gets Undo. It drives the app
  through the command list (`open_note`, `run_app_command`, Go and View commands only). Streams
  over SSE, stateless on the server; 12 model calls per turn at most; token counts shown
  (prices aren't, since they change). Tested end to end with a fake provider
  (`test/fakeAi.ts`). Not done from the plan: the assistant's own cursor colour in the note.
- **2026-10-11** — F15 sidebar toggle (release v0.0.6): the ▯| button at the top left of every
  screen shows and hides the file panel, and |▯ at the top right the links panel; both slide
  (the column widths are registered CSS properties, so they animate and the note widens
  smoothly), are remembered per laptop (`cp:left`, `cp:right`), and leave the tab order when
  hidden. **⌘\\** and "Show or hide the file panel" in ⌘K; search and tag clicks open it
  first. On the phone the same icon opens the drawer. `web/ui/PanelToggle.tsx`.
- **2026-10-11** — Milestone B, L1 MCP server (release v0.0.5): `POST /mcp` (Streamable HTTP,
  stateless JSON) with personal MCP tokens (`cpm_…`, read-only or read and write, revocable,
  bearer only); tools `list_vaults`, `search_notes`, `read_note`, `list_notes`, `list_tags`,
  `create_note`, `append_to_note`, `edit_note`, defined once in `src/tools.ts` for F13 to reuse.
  Runs as the user with their roles; every write saves the previous text as a version and merges
  with live typing. Account → Connect Claude; `docs/MCP.md`. Tested with the official MCP SDK
  client. Fixed on the way: a refused write left an unhandled rejection that crashed the server.
- **2026-10-11** — Milestone A, a daily driver (release v0.0.4):
  - **F6 Move to…** for notes and folders (`chooseDialog`), sharing one move-with-Undo path
    with dragging (`web/lib/moving.ts`).
  - **F3 Templates** (`Templates/`, `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`):
    Insert template… merges properties into the note's own; New note from template; Today
    uses `Templates/Daily.md`; daily notes get ‹ › and a month calendar in the side panel.
  - **One command list** (`web/lib/commands.ts`) behind the **⌘K palette**, the note's ⋯ menu,
    and the editor's **`/` menu** (F12 step 1: blocks, callout, table, code, divider, link,
    tag, date, picture, template, property; not in code, frontmatter or URLs). ⌘O stays the
    note switcher.
- **2026-10-11** — Quick capture from the iPhone (from the brainstorm): an Apple Shortcut in the
  share sheet posts links, text and photos to `POST /api/capture` with a per-person capture token
  (hashed, revocable, `Authorization: Bearer` only); they land as to-dos in an inbox note,
  appended through the live room so they never undo typing. Photos are converted server-side in
  a child process (HEIC → JPEG, 2048 px, EXIF upright; size-capped for the 512 MB instance).
  Account → Share from iPhone makes tokens and shows the steps; `docs/IPHONE-SHORTCUT.md`.
  Principle §10 (built to become iOS and desktop apps) and L8 added. Shortcut steps still to be
  checked on a real phone.
- **2026-10-11** — N10 one design language (`4da1fad`, release v0.0.2; v0.0.1 is the rollback
  point before it): shared `web/ui/` kit (Modal, Menu as popover or phone action sheet, the
  app's own confirm, prompt and Undo toasts) replacing all 25 browser dialogs; Undo instead of
  confirms for Trash, empty folders, members and version restore; `web/styles/` split per area
  on tokens (type scale, radii, motion with reduced-motion, layers, focus ring, tap size);
  44 px phone targets, folder ⋯ menus, one Edit/Read toggle on the phone. Enforced by
  `test/design.test.ts`; `bun run screens` for visual checks. Spacing is on a 4 px grid by
  convention but not yet tokenised.
- **2026-10-10** — F1 edit properties in place: text, number, date, checkbox and list (pills)
  values, add with a type, rename, remove, Edit YAML, and **⋯ → Add property** for notes with no
  frontmatter. Each edit rewrites only that property's lines (`web/lib/frontmatter.ts`), so
  comments and formatting elsewhere survive and edits merge with live typing. 5 browser tests,
  6 unit tests.
- **2026-10-10** — N8 iPhone photos (library and camera) upload as JPEG, checked on a real phone.
- **2026-10-10** — N1 Trash: deleted notes keep their history for 30 days and can be restored;
  live edits are flushed first. N2 photos shrink to 2048 px JPEG in the browser; admin page shows
  storage. N3 off-site backup: bearer-token `/api/backup` and a daily GitHub Action (Render's own
  PITR is 3 days on Hobby; exports kept 7). N4 `bun run test:ui` (13 headless-Chromium tests);
  it found that Live Preview links stayed "unresolved" until the note list loaded, now fixed.
  N5 plain-text outline. N6 vault home with only folders. N7 `render.yaml` drift documented,
  `SETUP_TOKEN` cleared.
- **2026-10-10** — Postgres 17 → 18 (L5): local Docker on `pgvector/pgvector:pg18`; production
  upgraded in place on Render, now Postgres 18.6 with pgvector 0.8.6, confirmed by the boot log.
  Failed live saves now retry instead of dropping unsaved edits (`ae68cb0`)
- **2026-10-10** — Drag and drop notes and folders, with mouse and long-press touch (`c01fff3`)
- **2026-10-10** — New folder button; empty folders persist and round-trip through zip (`660ab5d`)
- **2026-10-10** — Simultaneous creates return 409, not 500 (`74abddb`)
- **2026-10-10** — Live Preview renders frontmatter and tables; picture picker (`6b74b54`)
- **2026-10-10** — Live Preview and Source mode (`d446204`)
- **2026-10-10** — Setup token for the first admin; deployed to Render (`158af13`)
