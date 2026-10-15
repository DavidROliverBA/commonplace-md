# Contributing

Thanks for looking. Commonplace is a small project with a strong opinion about how it should
feel, so a short read first saves time on both sides.

## Before you start

- [README.md](README.md): what it does, and how to run it.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it's built, and why.
- [docs/PRINCIPLES.md](docs/PRINCIPLES.md): the design bar for anything a person sees.
- [CLAUDE.md](CLAUDE.md): the conventions in one page. It's written for coding agents, but it's
  the quickest summary for people too.
- [docs/BACKLOG.md](docs/BACKLOG.md): what's planned, and under **Decided against**, what was
  considered and rejected, with the reasons.

For anything bigger than a fix, open an issue first to agree the shape.

## Running it

```bash
docker compose up -d db
cp .env.example .env
bun install
bun run dev
```

Use `bun` and `bunx`, not npm.

## Checks

Every change must pass:

```bash
bun run typecheck
bun test          # needs the database container (it creates commonplace_test on first start)
```

A change to the interface must also pass `bun run test:ui` (headless Chrome). Look at
`bun run screens` on a laptop and a phone, in light and dark. [test/README.md](test/README.md)
describes the suites.

## Rules that the code depends on

- The markdown is the source of truth. Note writes go through `notes.persist()`, and writes from
  outside the editor go through `notes.overwriteContent()`.
- Never rebuild a note's Yjs state from text; diff into it (`src/ydoc.ts`).
- Schema changes are additive only (`create … if not exists`, `add column if not exists`).
- A new write route calls `vaultCtx(ctx, "editor")`, and a non-member gets 404.
- New UI uses `web/ui/` and the tokens in `web/styles/tokens.css`: no browser dialogs and no raw
  values. `test/design.test.ts` checks this.
- Every user action is registered in `web/lib/commands.ts`, and every setting lives in Settings.
- No secret goes in the repository or in a URL. Tokens go in `Authorization` headers.
