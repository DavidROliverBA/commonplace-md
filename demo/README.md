# Demo collections

Two made-up collections that show what Commonplace does. Each is a plain folder of Markdown files.

- **allotment/**: *The Allotment Notebook*, a personal notebook: plants, seasonal jobs, recipes,
  books and a journal. Wikilinks, a picture, callouts, tables, tasks, a Mermaid diagram,
  Dataview tables and an inline count, inline fields, and the Book and Idea types. Its
  `publish.json` publishes the whole collection with every website feature on; one private note has
  `publish: false`, and so do the type notes.
- **studio/**: *Harbour Studio*, a small design studio's notes: people, organisations, projects
  and meetings as types with relations, a Dataview dashboard, and a staff handbook. Its
  `publish.json` publishes only the `Handbook` folder, so the client and staff notes stay private.

## Trying one

1. `bun run demo` makes `demo/dist/allotment.zip` and `demo/dist/studio.zip`.
2. In the app, make a new collection, then Settings → Collection → Import markdown, and pick the zip.
3. Settings → Website shows the features and a preview; Publish makes the site.

The standalone version opens either folder as it is.
