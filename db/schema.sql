-- Commonplace schema. Postgres 18 + pgvector. Every statement is create-if-not-exists so
-- migrate.ts can run at every boot; changes are additive only (add column if not exists).

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Accounts (src/auth.ts): argon2id password hashes; the first account to sign up is the admin.
create table if not exists users (
  id            bigserial primary key,
  email         text not null unique,          -- stored lower-cased
  name          text not null,
  password_hash text not null,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Server-side sessions so a sign-out (or an admin removing a user) takes effect at once.
-- The cookie carries a random token; only its SHA-256 is stored.
create table if not exists sessions (
  token_hash  text primary key,
  user_id     bigint not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user on sessions(user_id);

-- A vault is a shared workspace: a folder of notes, but with members.
create table if not exists vaults (
  id          bigserial primary key,
  name        text not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Each person's home collection (F20): where Share from iPhone sends when its token says "home",
-- and where the app opens when there's no last-used collection. Cleared if the vault goes.
alter table users add column if not exists home_vault_id bigint references vaults(id) on delete set null;

-- Who can open a vault, and as what: owners manage it, editors write, viewers only read.
create table if not exists vault_members (
  vault_id  bigint not null references vaults(id) on delete cascade,
  user_id   bigint not null references users(id) on delete cascade,
  role      text not null check (role in ('owner', 'editor', 'viewer')),
  added_at  timestamptz not null default now(),
  primary key (vault_id, user_id)
);
create index if not exists vault_members_user on vault_members(user_id);

-- Invitations to a vault (N13). An owner invites an email; nothing is granted until that person
-- accepts, which is the only path into vault_members besides creating a vault. Keyed by email,
-- not user, so the reply never says whether an account exists and an invitation waits for someone
-- who signs up later. Membership checks read vault_members only, so a pending row grants nothing.
create table if not exists vault_invites (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  invited_by  bigint not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (vault_id, email)
);
create index if not exists vault_invites_email on vault_invites(email);

-- Notes. `path` is the vault-relative file path including ".md" (e.g. "Projects/Plan.md"),
-- so export is a straight write of path → content. `content` is the markdown; `ydoc` is the
-- Yjs CRDT state that live editing works on. `content` is always the materialised text of
-- `ydoc`; a null `ydoc` means the note has never been opened live, and its first room builds it
-- from `content`. Writes from outside the editor diff into `ydoc`, never replace it.
create table if not exists notes (
  id            bigserial primary key,
  vault_id      bigint not null references vaults(id) on delete cascade,
  path          text not null,
  content       text not null default '',
  ydoc          bytea,
  title         text not null,               -- basename without .md
  tags          text[] not null default '{}',
  frontmatter   jsonb not null default '{}',
  version       bigint not null default 1,
  embedded_hash text,                        -- content hash the chunks were embedded from
  created_by    bigint references users(id) on delete set null,
  updated_by    bigint references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  setweight(to_tsvector('simple', title), 'A') ||
                  setweight(to_tsvector('english', content), 'B')
                ) stored,
  unique (vault_id, path)
);
create index if not exists notes_search on notes using gin(search);
create index if not exists notes_tags on notes using gin(tags);
create index if not exists notes_title_trgm on notes using gin(lower(title) gin_trgm_ops);
create index if not exists notes_vault_updated on notes(vault_id, updated_at desc);
-- Lookups by path and title ignore case (findByPath, resolveLink); without these each is a scan
-- of the vault, which made a 10,000-note import quadratic.
create index if not exists notes_vault_lower_path on notes(vault_id, lower(path));
create index if not exists notes_vault_lower_title on notes(vault_id, lower(title));

-- Wikilinks and markdown links, re-derived on every save. `target` is the link text as
-- written, normalised (lower-case, no .md, no #heading) and resolved at query time, so a
-- link to a note that does not exist yet starts working the moment the note is created.
create table if not exists links (
  vault_id  bigint not null references vaults(id) on delete cascade,
  source_id bigint not null references notes(id) on delete cascade,
  target    text not null,
  primary key (source_id, target)
);
create index if not exists links_target on links(vault_id, target);

-- Heading-sized chunks of each note, embedded for semantic search and related notes.
-- 1024 dims for every provider: voyage-4-lite, mxbai-embed-large and the hash fallback produce it,
-- and relaxAI's 4096 are cut to the first 1024 (src/embed.ts).
create table if not exists note_chunks (
  id         bigserial primary key,
  note_id    bigint not null references notes(id) on delete cascade,
  vault_id   bigint not null references vaults(id) on delete cascade,
  ord        int not null,
  heading    text,
  body       text not null,
  embedding  vector(1024),
  provider   text not null
);
create index if not exists note_chunks_note on note_chunks(note_id);
create index if not exists note_chunks_embedding on note_chunks using hnsw (embedding vector_cosine_ops);

-- Point-in-time snapshots (Version history), taken at most every ten minutes while a note is
-- being edited and before overwrites from outside the editor (import, restore, agents, GitHub;
-- one per burst for agents). Multi-user editing needs an undo that survives other people's edits.
create table if not exists note_revisions (
  id         bigserial primary key,
  note_id    bigint not null references notes(id) on delete cascade,
  content    text not null,
  author_id  bigint references users(id) on delete set null,
  reason     text not null default 'edit',
  created_at timestamptz not null default now()
);
create index if not exists note_revisions_note on note_revisions(note_id, created_at desc);

-- Deleted notes, restorable with their history for 30 days (purged by notes.purgeTrash). Kept
-- out of `notes` so no search, link or export query has to filter them.
create table if not exists trashed_notes (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  path        text not null,
  content     text not null,
  ydoc        bytea,
  revisions   jsonb not null default '[]',
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null,
  deleted_by  bigint references users(id) on delete set null,
  deleted_at  timestamptz not null default now()
);
create index if not exists trashed_notes_vault on trashed_notes (vault_id, deleted_at desc);

-- Folders that exist on their own, so an empty folder persists. A folder that
-- holds notes or files is implied by their paths and needs no row.
create table if not exists folders (
  vault_id    bigint not null references vaults(id) on delete cascade,
  path        text not null,
  created_at  timestamptz not null default now(),
  primary key (vault_id, path)
);

-- Images and other non-markdown files from an imported vault (or uploaded later), so
-- ![[diagram.png]] renders and the export round-trips.
create table if not exists attachments (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  path        text not null,
  mime        text not null,
  size        int not null,
  data        bytea not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (vault_id, path)
);

-- Bearer tokens for clients that aren't the browser (src/tokens.ts): the iPhone capture Shortcut,
-- MCP agents, native apps later (docs/PRINCIPLES.md §10). Stored as SHA-256 hashes; shown once.
-- A capture token can only append to its note, in its vault, as its owner.
create table if not exists api_tokens (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  vault_id      bigint not null references vaults(id) on delete cascade,
  name          text not null,
  scope         text not null default 'capture',
  token_hash    text not null unique,
  note_path     text not null default 'Inbox.md',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists api_tokens_user on api_tokens (user_id);
-- MCP tokens (scope 'mcp' or 'mcp:read') cover every vault the person can see: no vault.
alter table api_tokens alter column vault_id drop not null;

-- Bring-your-own AI assistants (F13, src/assistants.ts). Per person, never shared with vault
-- members. The API key is encrypted with SECRETS_KEY (AES-256-GCM, src/secrets.ts) and never sent
-- back to the browser: the settings show only its last four characters.
create table if not exists user_assistants (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  name          text not null,
  provider      text not null,
  base_url      text not null default '',
  model         text not null,
  key_enc       text not null,
  key_hint      text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create unique index if not exists user_assistants_name on user_assistants (user_id, lower(name));
-- Prices (£ per million tokens; null = the list price in src/prices.ts) and a daily £ limit,
-- £1 unless changed. ai_usage is the ledger the limit is checked against: one row per assistant
-- per day (the server's TIME_ZONE), added to after every model call.
alter table user_assistants add column if not exists price_in numeric;
alter table user_assistants add column if not exists price_out numeric;
alter table user_assistants add column if not exists daily_cap numeric default 1.00;
-- May this assistant use the web (search and read pages) when a conversation turns it on? Off
-- until its owner allows it.
alter table user_assistants add column if not exists web boolean not null default false;
-- Each person's own web search key (Brave Search), sealed with SECRETS_KEY like AI keys.
create table if not exists user_search (
  user_id    bigint primary key references users(id) on delete cascade,
  provider   text not null default 'brave',
  key_enc    text not null,
  key_hint   text not null,
  created_at timestamptz not null default now()
);
-- The ledger: tokens and £ per assistant per day.
create table if not exists ai_usage (
  assistant_id  bigint not null references user_assistants(id) on delete cascade,
  day           date not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_gbp      numeric not null default 0,
  calls         int not null default 0,
  primary key (assistant_id, day)
);

-- Types (F16, src/types.ts): a note's type, from `type:` in its frontmatter (`Person`,
-- `"[[Person]]"` or `[Person]` all mean Person), kept as a column so type pages are an indexed
-- lookup at any vault size.
alter table notes add column if not exists type_name text generated always as (
  nullif(btrim(split_part(coalesce(frontmatter->'type'->>0, frontmatter->>'type'), '|', 1), ' []"'), '')
) stored;
create index if not exists notes_type on notes (vault_id, lower(type_name)) where type_name is not null;

-- This database's identity (F4): browsers keep notes for offline under names that include it, so
-- if the database is ever replaced, their old copies can't be merged into unrelated notes that
-- happen to reuse the same ids.
create table if not exists server_info (key text primary key, value text not null);
insert into server_info (key, value) values ('instance', gen_random_uuid()::text) on conflict (key) do nothing;

-- Bookmarks (F7): each person's starred notes, shown at the top of their sidebar.
create table if not exists bookmarks (
  user_id    bigint not null references users(id) on delete cascade,
  vault_id   bigint not null references vaults(id) on delete cascade,
  note_id    bigint not null references notes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, note_id)
);

-- GitHub vaults (F14, src/git.ts). Each person connects their own fine-grained token, sealed
-- with SECRETS_KEY like AI keys and never sent back to the browser.
create table if not exists user_github (
  user_id      bigint primary key references users(id) on delete cascade,
  token_sealed text not null,
  token_hint   text not null,
  login        text not null,
  created_at   timestamptz not null default now()
);

-- A vault copied from a repo (or one folder of it). Edits are a branch: `base_sha` is the commit
-- the vault was copied from (or last updated to), `branch`/`head_sha` are set once pushed, and
-- `merge_sha` is a newer base still to be merged into the branch on the next push.
create table if not exists vault_git (
  vault_id      bigint primary key references vaults(id) on delete cascade,
  repo          text not null,
  folder        text not null default '',
  base_branch   text not null,
  base_sha      text not null,
  base_tree     text not null,
  branch        text,
  head_sha      text,
  merge_sha     text,
  pr_number     int,
  pr_url        text,
  pr_state      text,
  pr_checked_at timestamptz,
  created_by    bigint references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Each file as it is at the base commit: where it lives in the repo, its git blob, an md5 of the
-- text or bytes as stored here (compared with md5() of the live row to find changes), and a
-- note's text, for diffs, reverts and three-way merges.
create table if not exists git_files (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  repo_path  text not null,
  git_sha    text not null,
  mode       text not null default '100644',
  hash       text not null,
  content    text,
  primary key (vault_id, path)
);

-- What the branch on GitHub holds for each changed path after the last push ('' = deleted).
create table if not exists git_pushed (
  vault_id bigint not null references vaults(id) on delete cascade,
  path     text not null,
  hash     text not null,
  primary key (vault_id, path)
);

-- How a vault's changes go to GitHub (F19): 'ask' (someone presses Push, as F14), 'review' (a PR
-- every hour, day or week), 'sync' (each note pushed to the working branch once idle) or
-- 'publish' (straight onto the base branch, on the schedule or once idle). Sent with `send_as`'s
-- token. `paused_why` null while paused means a person paused it; otherwise it's why sending stopped.
alter table vault_git add column if not exists send_mode text not null default 'ask';
alter table vault_git add column if not exists send_every text not null default 'day';
alter table vault_git add column if not exists send_at text not null default '18:00';
alter table vault_git add column if not exists send_day int not null default 5;
alter table vault_git add column if not exists send_soon boolean not null default false;
alter table vault_git add column if not exists send_as bigint references users(id) on delete set null;
alter table vault_git add column if not exists coauthor_emails boolean not null default false;
alter table vault_git add column if not exists next_run_at timestamptz;
alter table vault_git add column if not exists paused_at timestamptz;
alter table vault_git add column if not exists paused_why text;
alter table vault_git add column if not exists last_sent_at timestamptz;
alter table vault_git add column if not exists last_error text;
-- The git blob each pushed path holds on the branch, so a held note keeps its pushed version.
alter table git_pushed add column if not exists sha text;

-- Notes held back from pushes (F19) until someone releases them. Kept here, not as a property in
-- the note, which would itself be pushed.
create table if not exists git_held (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  held_by    bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (vault_id, path)
);

-- Notes changed both here and on GitHub that didn't merge line by line: the note keeps its text
-- here until someone picks a side; `theirs` is GitHub's (null = deleted there).
create table if not exists git_clashes (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  theirs     text,
  created_at timestamptz not null default now(),
  primary key (vault_id, path)
);

-- Saved searches: a search kept in the sidebar, run afresh each time it's opened (a smart
-- folder). Per person, like bookmarks; other editors keep the same thing as a "search" bookmark.
create table if not exists saved_searches (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  vault_id   bigint not null references vaults(id) on delete cascade,
  query      text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists saved_searches_one on saved_searches (user_id, vault_id, query);

-- Other names a link can use for a note (F9 step 1): its `aliases` (a list
-- or one string) and its AI-XF `id`, lowercased like stored link targets. Generated from the
-- frontmatter, so the markdown stays the only source; notes.linkKeys and resolveLink use it.
-- (AI-XF is a markdown exchange format; see F9 in docs/BACKLOG.md.)
create or replace function cp_link_names(fm jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct lower(btrim(x))) filter (where btrim(x) <> ''), '{}')
  from (
    select jsonb_array_elements_text(case jsonb_typeof(fm->'aliases') when 'array' then fm->'aliases' when 'string' then jsonb_build_array(fm->'aliases') else '[]'::jsonb end) as x
    union all
    select fm->>'id' where jsonb_typeof(fm->'id') = 'string'
  ) names
$$;
alter table notes add column if not exists link_names text[] generated always as (cp_link_names(frontmatter)) stored;
create index if not exists notes_link_names on notes using gin (link_names);

-- Published sites (F18, src/publish.ts). Publish takes a snapshot: the chosen notes rendered to
-- HTML and the files they show, copied as they were, so later edits stay private until the next
-- Publish. /p/<slug>/ serves only these tables, never notes or attachments, so nothing left out
-- can be reached by any URL. Unpublishing sets live = false and keeps the snapshot, for Undo.
create table if not exists sites (
  vault_id     bigint primary key references vaults(id) on delete cascade,
  slug         text not null unique,
  live         boolean not null default false,
  settings     jsonb not null default '{}', -- publish.json as it was published
  published_at timestamptz,
  published_by bigint references users(id) on delete set null
);
-- Each published note, rendered to HTML at Publish.
create table if not exists site_pages (
  vault_id   bigint not null references sites(vault_id) on delete cascade,
  path       text not null, -- the note's path without ".md": its address under /p/<slug>/
  note_path  text not null,
  title      text not null,
  html       text not null,
  source_md5 text not null, -- the note's text when published, for "changed since you published"
  primary key (vault_id, path)
);
-- What a page shows beside its text (F18 step 2): contents, backlinks, tags, date, word count.
alter table site_pages add column if not exists meta jsonb not null default '{}';
-- Copies of the files the published pages show, taken at Publish.
create table if not exists site_files (
  vault_id bigint not null references sites(vault_id) on delete cascade,
  path     text not null,
  mime     text not null,
  data     bytea not null,
  primary key (vault_id, path)
);
