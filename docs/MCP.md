# Connect Claude to Commonplace (MCP)

Commonplace runs a [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp`.
With it, Claude Code, or any other agent that speaks MCP, can search, read and write your notes
as you, in every collection you can see and with your role in each.

## Connect

1. In Commonplace, open **Settings → Connections → Connect Claude**. Name the connection, tick **Read only** if
   it should only look, and press **Create MCP token**.
2. Copy the command it shows, and run it in a terminal:

   ```bash
   claude mcp add --transport http commonplace https://<your-commonplace>/mcp \
     --header "Authorization: Bearer cpm_…"
   ```

3. In Claude Code, `/mcp` should list **commonplace** as connected. Try *"search my notes for
   the boiler service and summarise it into a new note"*.

The token is shown only once, so treat it like a password. Revoke it in the same place at any
time, and access stops at once.

### Other clients

The server speaks **Streamable HTTP** at `https://<your-commonplace>/mcp`. It is stateless and
answers every request with JSON. Authenticate with the header `Authorization: Bearer cpm_…`.
Never put the token in the URL: a token in a URL is refused.

For clients that only run local (stdio) servers, such as Claude Desktop's config file, bridge to
it with `mcp-remote`:

```json
{
  "mcpServers": {
    "commonplace": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-commonplace>/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer cpm_…" }
    }
  }
}
```

claude.ai's custom connectors need OAuth sign-in, which Commonplace doesn't offer yet. It's
in the backlog's ideas.

## Tools

| Tool | What it does | Needs write |
|---|---|---|
| `list_vaults` | Your collections, your role in each, note counts | |
| `search_notes` | Hybrid search (meaning and keywords), with `tag:` and `path:` filters | |
| `read_note` | Full markdown, tags, backlinks and outgoing links | |
| `list_notes` | Notes in a collection or folder, most recently edited first | |
| `list_tags` | Tags with counts | |
| `create_note` | A new note at a path | ✓ |
| `append_to_note` | Add to the end of a note (optionally creating it) | ✓ |
| `edit_note` | Replace one exact, unique piece of text | ✓ |
| `rewrite_note` | Replace a whole note, or one section under a heading (for reformatting) | ✓ |
| `set_properties` | Set or remove properties (frontmatter), leaving the rest alone | ✓ |
| `move_note` | Move or rename a note; links to it are updated | ✓ |
| `split_note` | Move a section into a new note, leaving an embed (`![[…]]`) | ✓ |
| `list_types` | The collection's types (Person, Meeting…) with their properties and counts | |
| `set_type` | Say what a note is and fill in its properties (choices checked) | ✓ |
| `create_type` | Make a new type: properties, icon, colour, template | ✓ |
| `merge_notes` | Fold a duplicate into another note, relink it, and send it to Trash | ✓ |
| `copy_to_vault` | Copy a note or folder to another collection (with its pictures and type), or move it: the original goes to Trash | ✓ |

A note can be named by its path (`Projects/Kitchen.md`) or its title, as in a `[[wikilink]]`.
A collection can be named by its id or its name, and can be left out if you have only one.

## Safety

- **Your permissions, never more.** A tool runs as you. In a collection where you're a viewer it can
  read but not write, and a read-only token doesn't even list the write tools.
- **Nothing is lost.** Every change first saves the note's previous text as a version
  (reason *mcp*), so Version history can undo any agent's change. A move can be moved back. Edits go through the live
  room, so they merge with whatever someone is typing at that moment.
- **No deletes.** No tool deletes a note outright: `merge_notes` sends the duplicate to Trash,
  and so does a move with `copy_to_vault`, restorable for 30 days. Claude Code asks before each tool call unless you
  allow it.
- **Text in notes is data.** A note can contain text aimed at an AI ("ignore your
  instructions…"). The guards above are what limit the damage: write access only where you
  chose it, a version saved before every change, and no deleting.

The tools are defined once, in `src/tools.ts`. The in-app assistant (`@name` and the ⌘J panel)
uses the same ones, and asks you before any change beyond the open note.
