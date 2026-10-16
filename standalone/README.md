# Commonplace standalone

Commonplace as a single HTML file that edits a folder of Markdown files. No server, account or
database: open the file in a browser, choose a folder, and edit. Nothing is uploaded.

```sh
bun run standalone        # writes standalone/dist/commonplace.html (about 1.1 MB)
bun run test:standalone   # builds it and drives it in Chrome
```

## What it does

- The app's editor: Live Preview, Source mode, edit-and-preview and reading view, with
  `[[wikilinks]]` (and `[[` completion), embeds, callouts, tables, Mermaid diagrams, Dataview queries and dataviewjs
  (run over the open folder; dataviewjs in a sandboxed frame), tasks, properties and tags.
- A file panel with folders, search across every note (words and `#tags`), and a tag list.
- Backlinks, outgoing links and the outline in the side panel.
- ⌘O opens a note by name; a link to a note that doesn't exist makes it, beside the note it was in.
- Pasted or dropped images are saved in `attachments/`, and `![[image.png]]` shows images from
  the folder.
- Rename, move and delete notes. Renaming doesn't rewrite links to the note.

## Browsers

- **Chrome and Edge** open a real folder (the File System Access API) and write each change back
  to the file half a second after typing stops. The last folder can be reopened with one click.
- **Safari and Firefox** can't write to a folder, so the folder (or some files) is read into the
  tab and edits stay there. **Download changes** saves the changed notes as a zip to unzip over
  the folder. Closing the tab with changes not downloaded asks first.

Hidden folders (`.git`, app settings) and `node_modules` are skipped.

## How it's built

`build.ts` bundles `main.tsx` with Bun and inlines the script and stylesheet into one page. It
reuses the web client as it is (`web/lib/livePreview.ts`, `render.ts`, `embeds.ts`, the dialogs
in `web/ui/`, every stylesheet) and swaps `web/lib/api.ts` for `api-shim.ts`, so the shared code
that would fetch a note from the server reads it from the open folder instead.

| File | What it is |
| --- | --- |
| `vault.ts` | The open folder: notes in memory, writes to disk, attachments as blob URLs |
| `App.tsx` | Welcome screen, file panel, search, the note screen and side panel |
| `Editor.tsx` | The app's CodeMirror setup without live collaboration (plain undo history) |
| `api-shim.ts` | Stands in for `web/lib/api.ts` |

What needs the server stays in the full app: live collaboration, sharing, semantic search, the
assistant, history, types, publishing and GitHub vaults.
