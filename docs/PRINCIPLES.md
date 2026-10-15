# Principles

Everything in Commonplace must be **easy to use**, with **one consistent design language**, and
done with **style and grace**. These principles turn that into decisions. Every backlog item is
judged against them, and a feature isn't done until it meets them on the laptop and the iPhone.

## 1. Easy before powerful

- A feature works the first time without instructions. If it needs explaining, the design isn't
  finished.
- Every action can be found from where you are: a visible button, the note's menu, the `/` menu
  (F12) or the block handle. Keyboard shortcuts are a bonus, never the only way in.
- Sensible defaults; settings only when people genuinely differ. Fewer, better options.

## 2. One design language

- **Tokens only.** Colours, type sizes, spacing, radii, shadows and motion come from the
  variables in `web/styles/tokens.css`. No raw hex values or one-off sizes in components.
- **One of each thing.** One button style (primary, secondary, quiet, danger), one menu, one
  modal and bottom sheet (`Modal.tsx`), one confirm, one text prompt, one toast, one input style,
  one icon set (`Icon.tsx`). A new feature reuses them; if it needs something new, that becomes
  the shared component.
- **No browser dialogs.** No `alert`, `confirm` or `prompt`: they look foreign, block the page and
  can't be styled. Use the shared confirm, prompt and toast.
- **One accent colour** for "this is the action". Colour is never the only signal.
- **Every setting lives in Settings.** Anything you set once and that stays set (preferences,
  connections, keys and tokens, members, vault options) is found in Settings
  (`web/components/Settings.tsx`), in its section, and nowhere else. Controls that change the
  view in front of you (sort order, edit or read mode, panel toggles, filters) stay where they
  act: they're remembered, but they aren't settings. A feature that needs a setting links to its
  section with `openSettings()`, rather than carrying a second copy of the form.

## 3. Calm: the writing comes first

- The note is the hero; chrome is quiet. Controls appear on hover, focus or selection, and get
  out of the way when you type.
- No badges, counters or animation that compete for attention. Status (saving, synced, offline,
  on a branch) is visible but small, in a consistent place.

## 4. As good on the iPhone

- Every feature is designed for the phone at the same time, not squeezed in later.
- Touch targets at least 44 px; bottom sheets instead of popovers; respect the safe areas and the
  on-screen keyboard; nothing that only works on hover (there is no hover).
- Light and dark mode are equal citizens; check both.

## 5. Forgiving

- Undo beats "Are you sure?". Prefer doing the thing and offering Undo in a toast.
- Nothing destructive without a way back: Trash, note history, cancel a branch. Ask for
  confirmation only when something truly can't be undone, and name what will be lost.
- Never lose what someone typed: not on a network drop, a failed save, a conflict or a crash.

## 6. Quick and honest

- Instant feedback: a click or tap responds within 100 ms, even if the work finishes later.
- Errors in plain words that say what happened and what to do next, never a stack trace or
  "Something went wrong".
- Show real state; never pretend something saved when it didn't.

## 7. Your markdown stays yours

- No feature locks content in. Everything round-trips through plain markdown and files
  compatible with other Markdown editors (properties, callouts, `.canvas`, attachments), and exports cleanly.
- Features that need extra data keep it in the note (properties) or in an open format, not in a
  hidden table, wherever possible.

## 8. Words and motion

- **Words:** plain British English, sentence case, verbs on buttons ("Move to Trash", "Open pull
  request", never "OK" or "Submit"). Short. Say "note", "vault", "folder" consistently.
- **Motion:** only to show where something came from or went; 150–200 ms, ease-out; none when
  the system asks for reduced motion.

## 9. Accessible

- Everything reachable by keyboard, with a visible focus ring. Labels on icon buttons. Text
  contrast at least WCAG AA in both themes. Works with VoiceOver on the iPhone.

## 10. Built to become an iOS and a desktop app

Commonplace runs in the browser today, and will also ship as an iPhone app and a desktop app
(L8). Build every feature so that move is a wrapper, not a rewrite:

- **API first.** Everything the web app does goes through the JSON API (`src/api.ts`); no
  feature exists only in the page. A native app is another client of the same API.
- **Tokens as well as cookies.** Non-browser clients authenticate with per-person, revocable
  bearer tokens in the `Authorization` header (never in a URL), with a scope for what each can
  do. The iPhone Shortcut (capture) is the first such client.
- **One web client, wrapped.** The React app is what the native apps show (Capacitor on iOS,
  Tauri on desktop), so no browser-only tricks that a web view lacks, and native features
  (the share sheet, files, notifications) arrive behind small interfaces in `web/lib/`.
- **Works offline, syncs later.** Notes are already CRDTs (Yjs); new data should merge the same
  way, not assume the server is always there.
- **Links open the app.** Every screen has a URL (`web/lib/router.ts`), so a deep link or a
  share can open the right note in any client.

---

## Checklist for every change

- [ ] Uses existing tokens and shared components; no new raw colours, sizes or browser dialogs.
- [ ] Any new setting goes in Settings; nothing to configure anywhere else.
- [ ] Discoverable without reading anything; works on the phone (touch, keyboard, safe area).
- [ ] Light and dark mode both checked.
- [ ] Mistakes can be undone; nothing typed can be lost.
- [ ] Feedback is immediate; errors say what to do.
- [ ] Content still exports as plain, portable markdown.
- [ ] Button labels are verbs; copy is short and sentence case.
- [ ] It works through the API, so a future iOS or desktop app gets it too.
