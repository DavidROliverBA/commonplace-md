# Tests

Three kinds, from fastest to slowest, plus the standalone file's own check. Run them from the repo root with `bun`.

| Suite | Files | Run | Needs |
|---|---|---|---|
| Unit | `test/*.test.ts` except `e2e.test.ts` | `bun test test/markdown.test.ts …` | Nothing: no database or outside network |
| End-to-end | `test/e2e.test.ts` | `bun test` (runs with the unit tests, so `bun test` fails without Postgres) | Postgres with a `commonplace_test` database |
| Browser | `test/ui/editor.ui.ts` | `bun run test:ui` | Postgres and Chrome |
| Standalone | `test/ui/standalone.ui.ts` | `bun run test:standalone` | Chrome only: builds the one-file version and edits a folder in the browser's private file system (port 3480) |

`bun run screens` (`test/ui/screens.ts`) isn't a test. It takes screenshots of the main screens
on a laptop and an iPhone, in light and dark, and saves them to `./screens/` (gitignored).

## Databases

Start Postgres with `docker compose up -d db`. It listens on `localhost:5434`.

- **e2e** uses `commonplace_test`. `db/init/` creates it the first time the container starts. On
  a cluster created before that, run
  `docker compose exec db psql -U commonplace -c "create database commonplace_test"` once.
  Each run drops and recreates that database's `public` schema. To use another database, set
  `TEST_DATABASE_URL`.
- **Browser tests** drop and recreate `commonplace_ui`, and **screens** do the same with
  `commonplace_screens`. Both connect through the `commonplace` database, or through
  `UI_ADMIN_DATABASE_URL` if it's set.

Never point any of these at a database whose data you want to keep.

## Chrome

`test/ui/chrome.ts` finds Chrome in this order: `CHROME_PATH`, a Playwright download in
`~/Library/Caches/ms-playwright`, then `/Applications/Google Chrome.app`. The browser tests drive
it headless through `puppeteer-core`. To debug them:

- `UI_DEBUG=1` prints page errors.
- `UI_WATCHDOG=1` reports any page that stops responding, with its stack.
- `A11Y_REPORT=1` prints every axe finding, not just the serious and critical ones.

## Fakes

Nothing calls a real provider. The servers under test are pointed at these fakes instead:

- **`fakeAi.ts`**: `startFakeAi(port)` speaks Anthropic's Messages API and OpenAI's Chat
  Completions, both streamed. It also serves relaxAI-style `/embeddings`. Push replies (text
  and/or tool calls) onto `script`, and read the requests it received from `seen`. Once `script`
  is empty, every reply is "ready". A key of `bad` gets a 401.
- **`fakeGitHub.ts`**: `startFakeGitHub(port)` is the GitHub REST API that GitHub vaults use
  (`src/github.ts`), over an in-memory git with real blob SHAs. It starts with a repo called
  `sam/house` and accepts only the token `TOKEN`. Every request goes into `seen`, so tests can
  check that the token never appears in a URL. `commitToMain` and `mergePr` stand in for someone
  working on GitHub, and `refuseNextPull` makes the next pull request fail.

## Conventions

- **Each test file starts with a header comment** saying what it covers and what it needs.
- **The servers are real.** e2e, the browser tests and screens each start `bun src/server.ts` on
  a port of their own, with `EMBEDDING_PROVIDER=hash` so nothing is fetched. The fakes and the
  test web pages also use fixed ports, a range per suite: e2e 3187–3199, the browser tests
  3286–3298, screens 3385–3399. With their own databases too, the three suites can run at once.
- **e2e has one `describe` per feature**, tagged with its backlog id where it has one (for
  example `GitHub vaults (F14)`). The describes run in order and share state: the users Alice and
  Bob, their first vault, and the `ids` of its notes. A describe may rely on the ones before it,
  so run the whole file. Live editing uses the stock `y-websocket` client.
- **Browser tests share state within a `describe` group**, such as which folders are open. Some
  groups call `freshBrowser()` first, which starts a new browser once 15 pages have been opened,
  because headless Chrome stalls after many. The suite collects page errors, console errors and
  any browser `alert`/`confirm`/`prompt` dialog. The last test fails if it collected any.
- **`design.test.ts` checks the design rules** in `web/` (no browser dialogs, values from
  `tokens.css`, every stylesheet loaded). It reads source files and runs nothing.
- **When you change the UI**, run `bun run screens` and look at the shots. If you add a screen,
  add a shot of it to `screens.ts`.
