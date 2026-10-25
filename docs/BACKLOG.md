# Backlog

What to work on next in Commonplace. Each item says why it matters, what "done" looks like, and
where the evidence is (a file and line, a commit, or something observed). Decisions already made
are recorded at the bottom, so they don't get re-argued.

Every item is judged against [PRINCIPLES.md](PRINCIPLES.md) (easy to use, one design language,
style and grace); its "done when" includes that checklist.

Sizes are rough: **S** an evening, **M** a few days, **L** a week or more.

Add new ideas under **Ideas** in a line or two; promote them to **Next** once it's clear what
done looks like. Finished items go to [CHANGELOG.md](CHANGELOG.md), and a finished item's
design moves to [design/](design/) (F12, F14, F16, F17, F19, F21 so far).

**Contents**

- [Now: risks and rough edges](#now-risks-and-rough-edges)
- [Next: in this order](#next-in-this-order)
- [Later](#later)
- [Ideas](#ideas)
- [Decided against](#decided-against)

---

## Now: risks and rough edges

Things that could lose data, stop the service, or that are visibly wrong today. These come
before features.

### N12 — Consolidation pass: check what's been built, not just that it passes

**Size** M · **Evidence** 22 releases in three days (v0.0.1–v0.0.22); every phone test is an
emulated iPhone in headless Chromium; principle 9 (accessible) has no check behind it; F16
claims speed at 10,000 notes but nothing measures it; the backup has never been restored

**Done when:**
- **Real iPhone:** the main journeys (open, edit, link, search, share from the phone, offline,
  Settings) are tried on a real iPhone in Safari and as a home-screen app, and what's wrong is
  fixed or listed here.
- **Accessibility (automated part done 2026-10-13):** axe (WCAG 2.1 A and AA) runs in the UI
  tests on the vault home, a note, a type page, Tasks, the command palette, every Settings
  section and sign-in, laptop and iPhone, light and dark, and finds nothing; a keyboard-only
  test opens, edits and settles a note and checks Tab never leaves a dialog. Fixed on the way:
  contrast (faint text, accent and danger tokens), names for the editor, task checkboxes,
  property inputs and selects, the view switch as a radio group, the palette and quick
  switcher as a combobox and listbox, a focus trap in dialogs, focus landing in the text when
  a note is opened from the keyboard, and a palette bug that listed every command when
  nothing matched. Still to do: VoiceOver on a real iPhone.
- **Speed at 10,000 notes (done 2026-10-13):** `bun run bench` builds a 10,000-note vault
  (links, tags, People and Meetings) and times the endpoints against budgets in
  `scripts/bench.ts`; all pass. It found three real problems, now fixed: a type page took 32 s
  and the graph didn't load at all (link resolution was a "path ends with" test against every
  note; now an equality join, 13 ms and 150 ms), and an import of 10,000 notes took 61 s
  (lookups by path had no index, and query plans made on the empty vault stayed scans; now
  12 s). In the browser the vault opens in ~150 ms, the quick switcher answers in ~45 ms, and
  note, type and task pages load in 75–130 ms.
- **Restore works (done 2026-10-13):** `scripts/restore.ts` restores a backup zip into an empty
  database, and an e2e test restores one and compares every note, file, version, folder and
  Trash entry. Done by hand too (2026-10-13): a real nightly artifact (2 vaults, 132 notes, 10
  files) restored into a scratch database with every note and file accounted for.
- **Stream the backup zip (done 2026-10-13):** `/api/backup` streams; a 472 MB backup peaked at
  315 MB of server memory (148 MB at rest), against the whole zip held before.

---

## Next: in this order

**Decided 2026-10-12, after taking stock.** Small writing improvements come between the large
items, chosen by what's used every day (see Ideas, such as `#Type` inline; the history diff, saved searches, focus mode, turning a
line into a typed note and the tour are done).

**Decided 2026-10-25, revised the same evening:** N12 (above) first (N15, the review pass, is done: see the CHANGELOG), then this list in
order, each kept to its first useful slice. The journal comes before Mac folders because it's
used every day and builds the real collections F20's presets wait on; Mac folders wait until
it's clear work notes belong in Commonplace on the Mac (the standalone file covers a folder
already).

1. ~~**F20, slim**~~ — done in v0.0.54 (Setup, starter-type sets, home collection, grouped
   menu; see the CHANGELOG). The built-in types (presets) wait until a few collections show what
   repeats; the rest of F20 is below.
2. **F24** — the journal, release 1, if it would replace Day One; otherwise just a Day One import
   and On this day. **Open question for David:** would it replace Day One?
3. **F25** — OAuth sign-in for the MCP server, so claude.ai and the Claude iPhone app can use
   the notes, not only Claude Code.
4. **F26** — `#Type` inline: typing `#Person Sam` makes the typed note as you type.
5. **F22, folder only** — a Mac collection whose master copy is a folder of Markdown.
   "Database" is the laptop kit as it is; "both" (two-way sync) waits until it's missed.
6. Then take stock. Waiting until there's a reason:
   - **F23**, one collection list on the Mac: only if two lists hurt after F22.
   - **The rest of F20** (presets, Change type, Close the programme): once a few real
     collections show what repeats.
   - **F18** steps 3–4 or **F11**: the site builder, themes and extras, or visual boards. F18
     steps 1–2 (publish, and the builder) are done.
   - **F9**: AI-XF identity and bundles, now smaller because F16 built its first step.

F19 (GitHub vaults sending on their own) is done, and N11 passed on the live site; F21 (the
graph's timeline) is done; see the CHANGELOG.

L8 (the iPhone and desktop apps) waits on the Apple Developer decision; F23 starts its desktop half.

### F20 — Vault types and setup: who it's for, where it's kept, what's switched on

**The slim part is done** (v0.0.54): Setup at the top of Settings → This collection (where it's
kept, people, home, starter types), the five sets below as **starter-type sets** (15 new starter
types), a home collection per person (Share from iPhone's "Home collection" token follows it), and
the collection menu grouped by where each is kept. **Still to do**, when a few collections show
what repeats: the presets themselves (`kind`, `setup` jsonb), Features switches, Change type, Save
as a new type, Close the programme, the assistant knowing the type, and the People rules.

**Size** M · **Evidence** a vault today is a name, members and an optional GitHub repo
(`db/schema.sql` `vaults`); every vault starts the same and every feature shows everywhere.
Decided 2026-10-25.

A vault's **setup** is four choices, all in one place, Settings → This vault → **Setup**:

1. **People:** just me, or invited people (owner, editor, viewer as now).
2. **Where it's kept:** cloud (the server's database), cloud + GitHub, or a Mac vault (F22).
3. **Features:** journal (F24), website, AI assistant, search by meaning, and the timeline's date
   rules (F21).
4. **Starter types:** type notes added for the vault's kind, ordinary notes that can be removed.

A **vault type** is a named preset of those four. A preset, not a mode: choosing one fills in the
setup, and every choice stays changeable. Built in:

| | Personal | Household | Programme | Department | Reference |
|---|---|---|---|---|---|
| **For** | You alone | A few people sharing a home's notes | Work with a start and an end | A team's long-running knowledge | Material to read and publish |
| **Starter types** | Person, Book, Idea | Person, Home, Appointment, Document | Project, Meeting, Decision, Risk, Action, Stakeholder, Milestone | Team, Person, Process, Policy, Service, Meeting | Article, Topic, Source |
| **People** | Just me | Invited | Invited | Invited, many viewers | Invited, many viewers |
| **Journal** | On | Off | Off | Off | Off |
| **Website** | Off | Off | Off | Off | On |
| **Timeline dates** | Daily notes | Appointments, documents | Milestones, meetings, decisions, within start and end dates | Meetings | When made |

- **Change type** at any time: the new preset applies to the choices you haven't changed
  yourself; missing starter types are added; nothing is removed.
- **Save as a new type** keeps a setup as your own type (for example "Client engagement"),
  private to you. Shown with the built-in ones when making a vault.
- **Programme: Close the programme.** Everyone keeps read access; it drops to the bottom of the
  switcher. Reopen puts it back.
- **The switcher groups vaults** by where they're kept and their type, each with its icon.
- **A home vault:** one vault marked home, where Share from iPhone, quick journal entries and
  "copy to my notes" go unless you choose otherwise.
- **The assistant knows the vault's type**, so it can offer what fits (a RAID summary in a
  Programme, "reflect on this week" in Personal). Same tools as now.
- **Stored on the vault** (additive columns: `kind`, `setup` jsonb), never in a note, so notes stay
  plain Markdown; the export's `vault` record carries it, and import restores it.
- People: going from invited to just me means removing the others, with a warning; a Personal
  vault asks "this is a personal vault, invite anyway?" rather than refusing.

**Done when** a vault can be made from each built-in type and from a saved one, its type changed
and customised in Setup, the switcher groups vaults, the home vault receives shares, and it works
on the laptop and the iPhone in both themes. Help: a new page, `vaults.md`.

### F24 — Journal

**Size** M, in two releases · **Evidence** daily notes exist (`Daily/YYYY-MM-DD.md`, the
calendar in the side panel); journalling happens in Day One today.

Entries go in the **home collection's** daily note (F20, done in v0.0.54), under `## Journal`, each with its time
(`### 08:12`). On by default in Personal vaults.

1. **Release 1:** a **New journal entry** command (⌘K, the ⋯ menu, press and hold on Today) opening
   a short sheet that appends to today's note (a function passed to `overwriteContent`, so it
   can't undo live typing); a **journal page** of daily notes newest first, with a calendar to
   jump; **On this day** from earlier years; an `add_journal_entry` tool with a preview.
2. **Release 2:** **import from Day One** (its JSON export: times, photos as files, tags), and
   **Reflect on this week** (the assistant with the week's entries and a prepared request).

Journal sections stay out of published sites unless chosen.

**Open:** entries in the daily note (planned) or a note each; whether entries record mood or
location; on the phone, a menu on Today or a Journal button.

**Done when** release 1 works on the laptop and the iPhone in both themes with a browser test,
and release 2 imports a real Day One export.

### F25 — OAuth sign-in for the MCP server

**Size** M · **Evidence** `docs/MCP.md`: claude.ai's custom connectors (and so the Claude iPhone
and desktop apps) need OAuth; today only Claude Code and `mcp-remote` work, with a bearer token
from Settings → Connections (`src/tokens.ts`, `src/mcp.ts`).

The MCP server offers OAuth 2.1 with PKCE, as the MCP authorization spec asks: metadata at the
well-known addresses, dynamic client registration, and a consent page in the app ("Claude wants
to read and write your notes as you", with read-only as a choice). Signing in issues the same
kind of hashed, scoped, revocable token as today, listed in Settings → Connections with the
client's name and last use. Bearer tokens keep working.

**Done when** claude.ai adds Commonplace as a custom connector, searches and reads notes and
(when allowed) writes one, the token shows in Connections and revoking it cuts Claude off at
once, and an e2e test drives the whole flow with a fake client.

### F26 — `#Type` inline

**Size** S · **Evidence** "Turn into a typed note…" (v0.0.29) already makes a typed note from a
selection; the `#` menu offers tags (`web/lib/`), and F20 added 15 starter types.

In the editor, `#` followed by a type's name (`#Person`) offers "New Person…" next to the
tags. Choosing it and typing a title (`#Person Sam Okafor`, then Enter) makes the note from the
type's template in the type's folder, and leaves a `[[Sam Okafor]]` link where the text was.
A tag with the same name as a type still works as a tag.

**Done when** it works in Live Preview on the laptop and the iPhone, Undo puts the text back,
and a browser test makes a note this way.

### F22 — Mac vaults: kept on the Mac, in a folder, its database, or both

**Size** L · **Evidence** the laptop kit (`laptop/`, v0.0.45) runs Commonplace and Postgres on
the Mac; the standalone file already edits a real folder (`standalone/vault.ts`).

A Mac vault lives only on the Mac. You choose where its notes are saved:

- **Folder:** a folder of `.md` files you pick is the master copy; edits made there by any
  editor arrive at once (the server watches it). The Mac's database holds only an index (search,
  links, graph), rebuilt from the folder whenever needed.
- **Database:** notes in the Mac's Postgres, with history and Trash as in the cloud; a folder
  export on request.
- **Both:** folder and database kept in step both ways; a note changed on both sides at once
  waits for you to choose, as GitHub clashes do (`git_clashes` is the model). Never conflict
  markers in a note.

A Mac vault is just you. It can add GitHub (F14, F19), which is how it reaches another machine
without the cloud. The AI assistant and search by meaning are switches, off by default, and say
that turning them on sends note text to your chosen provider. Writes still go through
`createNote` / `overwriteContent`, and the folder watcher through `overwriteContent`, so live
rooms see changes; renames and deletions in the folder become moves and Trash.

**Done when** each of the three works in the laptop kit, a change on either side reaches the
other, a clash waits for a choice, the folder survives a rebuild of the index, and the laptop
guide covers it.

### F23 — One vault list on the Mac: Mac vaults and cloud vaults together

**Size** L · **Evidence** decided 2026-10-25 (option A over keeping the laptop kit separate);
the first step of L8's desktop app, and a narrow first answer to L6 (federation).

The Mac Commonplace holds its Mac vaults itself and signs in to the cloud with a **device token**
(revocable, in Settings → Connections; L8 step 4) for the cloud vaults. One switcher shows both,
grouped. **Move to Mac** and **Move to cloud** reuse copy-and-move between vaults
(`src/between.ts`, v0.0.49) across the two servers: notes, attachments, types and history, the
original to Trash. The iPhone sees only cloud vaults. Offline, cloud vaults behave as F4 does
today and Mac vaults carry on as normal.

**Done when** one switcher shows Mac and cloud vaults, a note and a folder move each way with
Undo, the token can be revoked, and a cloud vault's live editing works from the Mac app as it
does from the browser.

### F18 — Publish a vault to the web: a site builder with themes and features to switch on

**Size** L, in four steps that each ship on their own · **Evidence** nothing is public today;
it takes over the old L2 (share one note by link): publishing one note is a site of one. Hosted publishing services are the model to
beat: a whole vault as a site, each note its own page, with links, graph and search.

Turn a whole vault (or chosen folders) into a **website**: each note is its own page at a
readable address (`/p/<site>/<note-path>`), `[[wikilinks]]` become links between pages, and
pictures come along. It's built with a **builder**: pick a theme, then switch each feature on or
off and customise it, with a live preview beside the controls, before anything goes public.

**What's chosen in the builder:**
- **What's published:** the whole vault, or folders, with a `publish: false` property to keep any
  note out. Links to notes that aren't published show as plain text, never as a dead link or a
  leak of the title. A "what will be public" list to check before the first publish.
- **Theme:** a few to start (for example a clean reading theme, a notebook, a wiki or docs
  layout, a minimal blog), each a set of design tokens, so they stay in the design language.
  Customise: accent colour, fonts from the type scale, site title, logo, home page note.
- **Features, each on or off:** navigation sidebar (folder tree), table of contents, backlinks,
  hover previews, tags pages, search, graph, light and dark switch, "last updated" dates, an RSS
  feed for a folder, reading time. Some have options of their own (graph: local or whole site).
- **Who can see it:** public, or unlisted (not indexed by search engines; the default), with a
  site password as a later option.

**How it's served (decided 2026-10-12):** by this server, from a **snapshot taken when you
press Publish**: the chosen notes and pictures are rendered and stored as they were, so edits
stay private until you publish again. The builder shows "N notes changed since you published"
and what a republish would add, change or take down.
Members' emails, other people's private vaults, comments, history and properties marked
private are never in a page. The builder sits under Settings → This vault (F17).

**Site settings are a file in the vault (decided 2026-10-12):** `publish.json` at the vault's
top level holds the theme, features, options and what's included. The builder edits it; it
goes out with an export, comes back with an import, and in a GitHub vault (F14) it's committed
like any other file. The snapshot records which version of it was published.

**Steps** (step 1 done 2026-10-13, v0.0.32: `src/publish.ts`, Settings → Website; see the
CHANGELOG):
1. ~~Publish a vault with one theme: choose folders, exclude notes, unlisted link, unpublish.~~
   Still to do from step 1's list: properties marked private (pages show no properties yet), and
   a "publish this note" toggle in the note's ⋯ menu.
2. ~~The builder: feature toggles with the live preview.~~ Done 2026-10-18, v0.0.43: page list,
   contents, backlinks, tag pages, last updated, reading time, light and dark switch. Hover
   previews need script, which pages don't run, so they're left out; search, graph and RSS are
   step 4.
3. Themes and customisation (colours, fonts, logo, home page).
4. Extras: search, graph, RSS, and a **custom domain as an option (decided 2026-10-12)**: you
   enter a domain such as `notes.example.com`, the builder shows the DNS record to add, the
   domain is added to the Render service (by its API, or a step the admin does), and requests
   for that host are served the site. Without one, the site lives at `/p/<site>/`.

**Open question:** whether a custom domain can be added through Render's API with the
service's key, or must stay a manual admin step (Render issues the certificate either way).

**Done when** each step works on the laptop and the iPhone in both themes, the published pages
pass the accessibility checks in [PRINCIPLES.md](PRINCIPLES.md), and a test proves an excluded
note, its title and its attachments can't be reached by any URL.

### F11 — Visual boards: a whiteboard view of notes (Heptabase / Scrintal / JSON Canvas)

**Size** L, in four steps · **Evidence** JSON Canvas 1.0 (jsoncanvas.org, the open `.canvas`
format); Heptabase and Scrintal feature research (2026-10-11), below

Heptabase and Scrintal are infinite-canvas note tools: notes become cards on a board, arranged
spatially and joined by arrows. The defining idea in both is that **a card is the note itself**:
one note can sit on several boards, and editing it anywhere updates it everywhere. Heptabase adds
sections, nested boards, mind maps and tidy-up layout; Scrintal adds nested "boards on boards"
and shows a board's connections as backlinks in the cards. Heptabase's help docs reportedly put
noticeable lag at 100–150 cards on one board.

**Store boards as JSON Canvas `.canvas` files, so they round-trip with other Markdown editors.** The format
is small: `nodes` (`text`, `file` with optional `#subpath`, `link`, `group` with a `label`),
each with integer `x`, `y`, `width`, `height` and an optional `color`, drawn in array order
(z-index); and `edges` with `fromNode`/`toNode`, optional sides, arrow ends, `label` and
`color`. Colours are hex or presets `"1"`–`"6"` (red, orange, yellow, green, cyan, purple),
which ties in with F10's palette. In Commonplace a board is a document in the vault, edited live
through Yjs like a note (nodes and edges as Y.Maps, so two people can move different cards at
once), and exported or imported as `.canvas`.

1. **View and import (M).** `.canvas` files from an existing vault import and open as boards:
   pan and zoom (pinch on the phone), note cards showing the note rendered, text and link
   cards, groups, labelled arrows. Imported canvases also export unchanged.
2. **Edit boards (M).** Drag notes from the sidebar or search onto the board, create a new
   note as a card, draw and label arrows, group cards into sections, resize, colour. Touch:
   long-press to drag a card (as the file tree does), two fingers to pan and zoom.
3. **Notes know their boards (S).** A note's side panel lists the boards it's on, and arrows
   between note cards show in backlinks as "on board X". An option promotes an arrow to a relation
   property in the note (F16, as F9 maps them), so the connection survives outside the board; by default
   board arrows stay board-only.
4. **Heptabase extras (M, optional).** Nested boards (a card that opens another board), a mind
   map layout, tidy-up and auto-arranging a section.

**Choosing a library is part of step 1.** React Flow (`@xyflow/react`, MIT) suits cards and
edges and handles pan, zoom and touch; Excalidraw (MIT) suits freehand sketching rather than
note cards; tldraw is polished but its licence must be checked for this use. Decide with a
spike: 150 cards on an iPhone must pan and zoom smoothly, the size at which Heptabase is said to
slow down.

**Done when** an existing vault with canvases imports and its boards look the same; a board made
in Commonplace opens in other Markdown editors; two people can arrange the same board at once; and a note
edited on one board shows the change on every board it's on.

### F9 — AI-XF: identity and bundles in and out (after F16)

**Size** M overall, in three steps · **Evidence** AI-XF v0.5
(the AI-XF spec: §4 concepts, §5 fields, §6 links, §9 namespaces,
§11 conformance); Longview's exporter and importer; F16 types
(`src/types.ts`), which already give `type:`, a type picker, `type:` search and types in the
tree and graph

AI-XF is markdown with YAML frontmatter, so a Commonplace note is already nearly an AI-XF
concept, and F16 built what this item's first plan called step 1 (types). What's left is
identity and exchange, so a vault can go to and from Longview and any other AI-XF or
OKF reader without a translation layer.

**Decided 2026-10-12: one way to write relations.** F16 relations (`attendees: [[Sam]]`) are how
notes are linked in Commonplace. AI-XF typed links (`links: [{rel, to}]`) are not a second
editor: on export each relation property becomes a typed link with the property name as its
`rel` (`attendees` → `attendees`, or a mapped core rel such as `depends-on`), and on import
typed links become relation properties. So there's never a choice between two ways of saying
"this meeting involved Sam".

1. **Identity (S).** Links resolving by `aliases` and `id` is **done (2026-10-13, v0.0.31)**:
   `notes.link_names` is generated from the frontmatter, and the server (`linkKeys`,
   `resolveLink`) and the browser (`resolveLocal`) use it after path and title. Still to do:
   `id` shown and generated from the title (lowercase kebab-case, no `/`) and kept on rename;
   the `[[` autocomplete offering aliases (inserting `[[Title|Alias]]`).
2. **Export a vault or folder as an AI-XF bundle (M).** The zip gains `manifest.ai-xf.yaml`
   (`ai-xf`, `name`, `namespace`, `vocabularies`), writes relations as typed links (above) and
   mirrors them as body links (§6.4, for OKF), and writes `generated`/`provenance` to reach
   Level 2, or Level 3 with a namespace. Notes without a type export as `Note`. Frontmatter is
   written in the canonical form (§5.7) **on export only**: writing it on save would reorder
   frontmatter people wrote by hand. Checked in CI with the reference validator
   (`tools/ai-xf-validate.py --level 3`).
3. **Import an AI-XF bundle (S–M).** The importer recognises a manifest, keeps every
   frontmatter key verbatim (§7.3a: `verified` is never invented), maps `id`s, turns typed
   links into relation properties, and turns cross-bundle `namespace/id` references into links
   that show as external until that bundle is imported too.

**Done when** a Longview export imports into a vault with its types, ids and links intact as
relation properties; that vault exports again and passes the reference validator at Level 3;
and nothing about writing notes in Commonplace changed to get there.

---

## Later

### L3 — Comments on notes

**Size** M–L

Yjs relative positions would let a comment stay anchored to text while it's edited. For a
shared vault more than a personal one, so it waits until a vault has regular second editors.

**Done when** I can select text, comment on it, and see the comment stay attached while the
text around it is edited by someone else; comments resolve and never enter the markdown.

### L4 — More than one server instance

**Size** L · **Evidence** rooms and event streams live in server memory (`src/collab.ts`,
`src/events.ts`); `render.yaml` pins one instance

Only needed if one instance stops being enough. It needs a shared channel (Postgres
`LISTEN/NOTIFY` or Redis) for Yjs updates and events, plus sticky sessions or per-note routing.

### L6 — Federating several Commonplace instances: investigate and decide

**Size** S to decide; the work that follows is mostly F9 (the MCP server, once L1, shipped in v0.0.5) · **Evidence** AI-XF v0.5 §9
(namespaces, `namespace/id` references, `federation.ai-xf.yaml`, §9.8 serving a federation over
MCP); Longview's federate mode (`longview/docs/AI-XF.md`, pinned bundles, trust not inherited);
one instance already holds many vaults with per-vault roles (`src/vaults.ts`)

**Why more than one instance at all.** Within one household or team, separate vaults in one
instance already give separate spaces and permissions. Separate instances only make sense across
an ownership or trust boundary: a personal instance and a work one that must stay on work
infrastructure, or two families sharing selected notes. Federation should respect that
boundary, not erase it.

| Option | What it gives | Cost and risk | Provisional verdict |
|---|---|---|---|
| **A. Agent-level, over MCP** — each instance runs its own MCP server (`/mcp`, built); an AI client connects to several | Claude can search, read and answer across instances in one conversation | Small: the MCP server exists, so this needs only the spike below. No server-to-server trust: each instance keeps its own auth and data never moves | **Do it first.** It's the cheapest way to get the main benefit, and the safest for work data |
| **B. App-level, over AI-XF** — an instance subscribes to another's published bundle (read-only, refreshed on a schedule, under its namespace) | Cross-instance search, `[[ns/id]]` links and backlinks in the Commonplace UI | Medium: F9 steps 3–4 plus a subscription, refresh, and display of foreign notes as read-only. Copies the other side's data, so only for what its owner chose to publish | **Do after F9**, if A proves the need |
| **C. Server-to-server over MCP** — one instance calls another's MCP tools | Live cross-instance queries from the app | MCP is designed for AI clients calling tools, not app-to-app data access; it adds a protocol hop with no gain over B's HTTPS + bearer token | **No.** Use AI-XF over HTTPS for app-to-app |
| **D. Live multi-master sync** — vaults replicated between instances, edits merged | One vault editable in two places | Large: cross-server identity, auth, Yjs sync across servers, conflict and deletion semantics. Little gain over sharing a vault in one instance | **No** |

**Questions the investigation must answer:**
- Is there a real second instance? If every use is one household, this stays shelved, and
  multiple vaults are the answer.
- For A: does one MCP server per instance (with per-user bearer tokens) work well enough in
  Claude Code and claude.ai with two or three connected at once? Measure on a real question that
  spans both.
- For B: what does a publisher choose to share (a vault, a folder, a tag), and how is that kept
  from leaking private notes? AI-XF §7.5 withheld markers apply.
- Trust: a federated note must show where it came from and must not inherit the other side's
  verification (AI-XF §7.3a, §9.4).

**Done when** the conclusion (adopt A, A then B, or shelve) is written here with the evidence
from a spike: two local instances, one MCP server each, and one question answered across both.

### L7 — Scaling and high availability: what Render offers, and Render vs Supabase

**Size** S to decide · **Evidence** render.com/pricing and Render's Postgres docs; supabase.com/pricing
and its compute, disk and Multigres docs (all 2026-10-11)

**Where Commonplace is today:** web service Starter ($7), Postgres `0.1c-256mb` ($6) with 1 GB
($0.30), Hobby workspace ($0): **about $13 a month**, with 3 days of point-in-time recovery and
the daily GitHub backup (N3).

**The real limit is the app, not the database.** Commonplace runs as one server because live
editing keeps open notes in memory (L4). High availability on the database alone doesn't make
the app highly available; if the one web server is down, so is Commonplace. Do L4 first if
uptime ever matters, and database HA alongside it.

| | Render Postgres | Supabase |
|---|---|---|
| Entry price | $6/mo (0.1 CPU, 256 MB), Hobby workspace free | Pro $25/mo incl. $10 compute (Micro, 1 GB RAM) and 8 GB disk; Free tier pauses after a week idle |
| Next sizes | 0.5c-1g $19 · 1c-2g $40 · 1c-4g $55 · 2c-8g $100 | Small $15 · Medium $60 · Large $110 (on top of the $25) |
| Storage | $0.30/GB, grows in 5 GB steps or automatically, never shrinks | $0.125/GB after 8 GB, grows, never shrinks |
| Point-in-time recovery | Included: 3 days (Hobby), 7 days (Pro workspace, $25/mo) | Add-on: $100/mo per 7 days; daily backups 7 days on Pro |
| High availability | Yes, on any workspace: a standby in another zone, automatic failover after 30 s; needs ≥1 CPU; billed as a second copy | Not on Pro or Team; Multigres (3-node HA) is in alpha, not for production |
| Read replicas | Up to 5; needs ≥10 GB and ≥0.5 CPU; billed as a copy | Yes, billed as extra compute |
| Runs the Bun server? | Yes, same platform, private network | No; the web server stays on Render, the database goes over the internet |
| Extras | — | Auth, storage, realtime, generated APIs (Commonplace already does all of these itself) |

**Decided (2026-10-11): stay on Render** (see Decided against): at ~$13 a month it's cheaper
than Supabase on the database alone, includes 3-day point-in-time recovery, and offers HA that
Supabase doesn't yet. Render with database HA would be ~$90 a month (1c-2g twice, with L4).
Revisit if the data passes ~20 GB or Supabase's Multigres becomes generally available.

**Still open:** a named trigger (users, data size, an outage) for moving the database to
`1c-2g` with HA, done together with L4. Until then, stay as is.

### L8 — Commonplace as an iPhone app and a desktop app

**Size** L · **Evidence** PRINCIPLES.md §10; the capture Shortcut (2026-10-11) is the first
non-browser client; Safari can't receive shares (WebKit bug 194593)

Wrap the same web client rather than rewrite it: **Capacitor** for iOS (App Store or
TestFlight; needs the $99/year Apple Developer Program) and **Tauri** for macOS and Windows.

1. **iOS app (M):** the web client in a native shell, signed in with a device token; a real
   **share extension** (links, text, photos, files) replacing the Shortcut; the home-screen
   icon and splash; deep links (`commonplace://…` and universal links) open notes.
2. **Offline in the app (S):** F4 already opens and edits notes offline in the browser; check
   it carries over to the native shell's storage.
3. **Desktop app (M):** Tauri window, menu bar and shortcuts, open-at-login, drag files in;
   optionally a local folder mirrored as a plain folder of Markdown files.
4. **Device tokens (S):** the capture tokens grow into per-device tokens with scopes
   (capture, full), listed and revocable in Settings → Connections.

**Done when** the iPhone app is on TestFlight with a share extension that saves into the
inbox, the desktop app runs on macOS, both sign in with revocable device tokens, and neither
needed a feature the web app doesn't have.

---

## Ideas

One line each. Promote to **Next** with a "done when".

- The assistant's web, next: another search provider (or the provider's own search for Anthropic and OpenAI), PDFs, and a remembered globe setting per assistant
- Three editions, as Longview has: the private repo (personal, deployed, with backups) feeds the
  public one (`commonplace-md`, a snapshot per release), which a work edition could start from in
  the employer's own repository, with its own sign-in and hosting. Nothing from the work edition
  comes back.
- Folder and tag colours in the sidebar, stored per vault (other editors keep these in plugin
  settings, not in notes; see F10)
- Import from Apple Notes or Notion
- Per-vault theme or accent colour (F18's themes are tokens too; share them)

From the brainstorm of 2026-10-11 (sizes rough; each must meet [PRINCIPLES.md](PRINCIPLES.md)):

- **Media as objects (M, after F16, from Capacities):** pictures and PDFs get a page of their own,
  with properties, backlinks ("used in 3 notes") and a place for notes about them
- **Another name for the `type` key (S, from F16):** for an imported vault where `type:`
  already means something else; a vault option in Settings → This vault
- **Presence (S):** who's in the vault and which note they're in, and "follow" someone's cursor
- **Activity feed (M):** what changed in a shared vault since you last looked, per note and person
- **Typography settings (S):** font and size choices, within the design language's scales, in
  Settings → Account
- **Voice notes (M):** record on the iPhone, keep the audio as an attachment, transcribe with
  your own AI key (F13)
- **Searchable photos and PDFs (M):** text in pictures and scans extracted and indexed for search

---

## Decided against

- **Hover previews on published sites (F18, 2026-10-18):** they need script, and published pages
  run none (the CSP allows none, so nothing on a page can act as the app). Links go to the page.
- **Database storage autoscaling (2026-10-12):** kept off on purpose. While Commonplace is in
  development there's no reason to pass 1 GB, and storage never shrinks once added, so a
  runaway write would quietly raise the bill for good. The server guards the disk itself
  instead (`src/storage.ts`: new data refused at 90%, one version per agent burst, 100 versions
  a note, 5 MB a note). Revisit when real use approaches the limit; then raise `DB_DISK_GB`
  with the disk.
- **Copying a GitHub repo in from its zipball (F14, 2026-10-12):** the Git Trees and Blobs APIs
  fetch only the chosen folder and file types, give each file's sha for later updates, and let
  size limits apply before anything is downloaded.
- **A monthly schedule for F19 (2026-10-12):** a month of changes is too big a PR to review,
  and the branch drifts far from `main`. Hourly, daily or weekly.
- **A new PR every period while one is open (F19, 2026-10-12):** one open PR at a time; a new
  period's changes are added to it until it's merged.
- **A second way to write relations (F9, 2026-10-12):** AI-XF typed links (`links: [{rel,
  to}]`) are an export and import format, not an editor of their own; F16 relation properties
  are how notes are linked.
- **Writing AI-XF canonical frontmatter on every save (F9, 2026-10-12):** it would reorder
  frontmatter people wrote by hand; canonical form is written on export only.

- **Writing colours as `=={red}…==` or classes (2026-10-12):** Commonplace writes HTML
  (`<mark style="background: …">`, `<span style="color: …">`) because it shows in other Markdown editors,
  Typora and any HTML viewer with no plugin; the cost is that editors don't render markdown
  inside, so colour wraps plain text. Hilo's syntax and Highlightr's classes are read, not
  written, as they need a plugin to show.
- **Moving the database to Supabase** (2026-10-11) — Commonplace doesn't use Supabase's bundle
  (auth, storage, realtime, APIs); on the database alone Render is cheaper at this size, includes
  point-in-time recovery, offers HA that Supabase doesn't on Pro, keeps app and database on one
  private network, and runs Postgres 18 (unconfirmed on Supabase). Comparison in L7.
- **`alter extension vector update` at boot** — Render's upgrade already moved pgvector to 0.8.6,
  but the server's default version is 0.8.1, so a bare update tries to downgrade and fails; the
  deploy crashed on start (`1786788`, reverted in `0bd265b`). Leave extension versions to Render.
- **HTML5 drag and drop for the file tree** — iPhone Safari doesn't support it reliably; the tree
  uses pointer events with a long press on touch (`web/lib/useTreeDrag.tsx`).
- **Empty folders kept only in the browser** — they'd vanish on reload and be invisible to other
  members; they live in the `folders` table instead.
- **React StrictMode** — its double-mounted effects open and close each note's live socket twice
  (`web/main.tsx`).
- **Rebuilding a note's Yjs state from its text** — duplicates text when an offline client
  reconnects; external writes are diffed in (`src/ydoc.ts`, see `CLAUDE.md`).
