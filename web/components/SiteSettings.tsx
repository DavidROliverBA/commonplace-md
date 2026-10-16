// Settings → Website (F18 step 1): choose what's published, check what will be public, Publish,
// and take the site down. Publishing copies the chosen notes as pages (src/publish.ts), so edits
// stay private until the next Publish; this lists what a republish would add, change or take down.

import { useEffect, useState } from "react";
import { api, type Vault } from "../lib/api";
import { relativeTime } from "../lib/links";
import { toast, toastError } from "../ui/overlays";

interface SiteState {
  settings: { include: string[] };
  error: string | null;
  folders: string[];
  notes: string[];
  noteCount: number;
  held: string[];
  files: string[];
  fileCount: number;
  site: { slug: string; live: boolean; publishedAt: string; publishedBy: string | null; pages: number; files: number } | null;
  changes: { added: string[]; changed: string[]; removed: string[]; settings: boolean } | null;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const shown = (p: string) => p.replace(/\.md$/i, "");

function PathList({ summary, paths, total }: { summary: string; paths: string[]; total?: number }) {
  if (!paths.length) return null;
  return (
    <details className="site-paths">
      <summary>{summary}</summary>
      <ul>
        {paths.map((p) => (
          <li key={p}>{shown(p)}</li>
        ))}
        {total !== undefined && total > paths.length && <li className="muted">and {total - paths.length} more</li>}
      </ul>
    </details>
  );
}

export function SiteSettings({ vault }: { vault: Vault }) {
  const isOwner = vault.role === "owner";
  const [s, setS] = useState<SiteState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // "Chosen folders" with none ticked yet: the file still says the whole vault until one is.
  const [picking, setPicking] = useState(false);

  const load = () => api<SiteState>(`/vaults/${vault.id}/site`).then(setS, toastError);
  useEffect(() => void load(), [vault.id]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  if (!s) return <p className="muted">Loading…</p>;
  const url = s.site ? `${location.origin}/p/${s.site.slug}/` : "";
  const include = s.settings.include;
  const chosen = picking || include.length > 0;
  const covered = (f: string) => include.some((i) => f.startsWith(i + "/"));
  const c = s.changes;
  const pending = c ? c.added.length + c.changed.length + c.removed.length : 0;

  const choose = (next: string[]) =>
    run("Saving…", async () => {
      await api(`/vaults/${vault.id}/site/settings`, { method: "PUT", body: { include: next } });
      setPicking(next.length === 0 && chosen);
    });
  const toggle = (f: string, on: boolean) => choose(on ? [...include.filter((i) => !i.startsWith(f + "/")), f] : include.filter((i) => i !== f));

  const publish = () =>
    run("Publishing…", async () => {
      const r = await api<{ pages: number; files: number }>(`/vaults/${vault.id}/site/publish`, { method: "POST", body: { offset: -new Date().getTimezoneOffset(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      toast(`Published ${plural(r.pages, "page")}${r.files ? ` and ${plural(r.files, "file")}` : ""}`);
    });
  const setLive = (live: boolean) => api(`/vaults/${vault.id}/site/live`, { method: "PUT", body: { live } });
  const takeDown = () =>
    run("Taking down…", async () => {
      await setLive(false);
      toast("Website taken down: the link shows nothing now", { undo: () => setLive(true).then(load) });
    });
  const copy = () => navigator.clipboard.writeText(url).then(() => toast("Link copied"), toastError);

  return (
    <>
      <section className="settings-section">
        <h3>Website</h3>
        {!s.site && <p className="muted">Publish this vault's notes as a website: each note a page, links between them working, pictures included. Publishing copies the notes as they are; your edits stay private until you publish again.</p>}
        {s.site?.live && (
          <>
            <p className="site-live">
              Live at{" "}
              <a href={url} target="_blank" rel="noopener">
                {url}
              </a>
            </p>
            <div className="row wrap">
              <button onClick={() => void copy()}>Copy link</button>
              <a className="button" href={url} target="_blank" rel="noopener">
                Open the site
              </a>
            </div>
          </>
        )}
        {s.site && !s.site.live && <p>Taken down: the link shows nothing until you put it back or publish again.</p>}
        {s.site && (
          <p className="muted">
            Published {relativeTime(s.site.publishedAt)}
            {s.site.publishedBy ? ` by ${s.site.publishedBy}` : ""}: {plural(s.site.pages, "page")}
            {s.site.files ? `, ${plural(s.site.files, "file")}` : ""}. Unlisted: only people with the link can find it, and search engines are asked to leave it out.
          </p>
        )}
        {!isOwner && <p className="muted">Only an owner of this vault can publish it.</p>}
      </section>

      <section className="settings-section">
        <h3>What's published</h3>
        {s.error && (
          <p className="error" role="alert">
            {s.error}
          </p>
        )}
        <div className="site-choice" role="radiogroup" aria-label="What's published">
          <label>
            <input type="radio" name="site-scope" checked={!chosen} disabled={!isOwner || !!busy} onChange={() => (setPicking(false), void choose([]))} /> The whole vault
          </label>
          <label>
            <input type="radio" name="site-scope" checked={chosen} disabled={!isOwner || !!busy || !s.folders.length} onChange={() => setPicking(true)} /> Chosen folders
          </label>
        </div>
        {chosen && (
          <ul className="site-folders" aria-label="Folders to publish">
            {s.folders.map((f) => (
              <li key={f} style={{ paddingLeft: `${(f.split("/").length - 1) * 16}px` }}>
                <label>
                  <input type="checkbox" checked={include.includes(f) || covered(f)} disabled={!isOwner || !!busy || covered(f)} onChange={(e) => void toggle(f, e.target.checked)} /> {f.split("/").pop()}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          To keep a note out, give it the property <code>publish: false</code>. Links to notes that aren't published show as plain words. The choice is saved in <code>publish.json</code>, so it goes with an export.
        </p>
      </section>

      <section className="settings-section">
        <h3>What will be public</h3>
        <p>
          {picking && !include.length ? "Tick at least one folder." : `${plural(s.noteCount, "note")} and ${plural(s.fileCount, "file")}.`}
          {s.held.length > 0 && ` ${plural(s.held.length, "note")} kept out by publish: false.`}
        </p>
        <PathList summary="See the notes" paths={s.notes} total={s.noteCount} />
        <PathList summary="See the files" paths={s.files} total={s.fileCount} />
        <PathList summary="Kept out by publish: false" paths={s.held} />
        {c && (
          <>
            <p>{pending || c.settings ? <b>Since you published: {[c.added.length && `${c.added.length} new`, c.changed.length && `${c.changed.length} changed`, c.removed.length && `${c.removed.length} to take down`, c.settings && "the folders chosen"].filter(Boolean).join(", ")}</b> : "Nothing has changed since you published."}</p>
            <PathList summary={`New (${c.added.length})`} paths={c.added} />
            <PathList summary={`Changed (${c.changed.length})`} paths={c.changed} />
            <PathList summary={`To take down (${c.removed.length})`} paths={c.removed} />
          </>
        )}
        {isOwner && (
          <div className="row wrap">
            <button className="primary" onClick={() => void publish()} disabled={!!busy || !s.noteCount || !!s.error || (picking && !include.length)}>
              {s.site ? "Publish changes" : "Publish"}
            </button>
            {s.site && !s.site.live && <button onClick={() => void run("Putting back…", () => setLive(true))}>Put it back as it was</button>}
            {s.site?.live && (
              <button className="danger-link" onClick={() => void takeDown()} disabled={!!busy}>
                Take the site down
              </button>
            )}
            {busy && <span className="muted">{busy}</span>}
          </div>
        )}
      </section>
    </>
  );
}
