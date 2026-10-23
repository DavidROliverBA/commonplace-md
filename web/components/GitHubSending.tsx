// Settings → This vault → Sending to GitHub (F19): how this GitHub vault's changes go to GitHub.
// Owners choose; whoever saves becomes the one who sends, with their own token. Everyone else
// sees what was chosen.

import { useEffect, useState } from "react";
import { api, type Vault } from "../lib/api";
import { DAYS, type GitStatus, MODES, refreshGit, type SendMode, setGit, useGit } from "../lib/git";
import { toast, toastError } from "../ui/overlays";

interface Draft {
  mode: SendMode;
  every: "hour" | "day" | "week";
  at: string;
  day: number;
  soon: boolean;
  coauthorEmails: boolean;
  branch: string;
}

const draftOf = (st: GitStatus): Draft => ({ mode: st.auto.mode, every: st.auto.every, at: st.auto.at, day: st.auto.day, soon: st.auto.soon, coauthorEmails: st.auto.coauthorEmails, branch: st.baseBranch });

function describe(d: Draft): string {
  const at = d.every === "hour" ? `at ${d.at.slice(3)} past each hour` : d.every === "day" ? `every day at ${d.at}` : `every ${DAYS[d.day]} at ${d.at}`;
  if (d.mode === "review") return `A pull request ${at} (UK time), if anything changed.`;
  if (d.mode === "publish") return d.soon ? `Straight onto ${d.branch} a couple of minutes after edits stop.` : `Straight onto ${d.branch} ${at} (UK time), if anything changed.`;
  return "";
}

export function GitHubSending({ vault }: { vault: Vault }) {
  const st = useGit(vault.id, null);
  const isOwner = vault.role === "owner";
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void refreshGit(vault.id), [vault.id]);
  useEffect(() => void (st && !d && setD(draftOf(st))), [st]);
  if (!st || !d) return null;

  const set = (p: Partial<Draft>) => setD({ ...d, ...p });
  const scheduled = d.mode === "review" || (d.mode === "publish" && !d.soon);
  const toMain = d.mode === "publish" && /^(main|master)$/.test(d.branch.trim());
  const saved = draftOf(st);
  const changed = JSON.stringify(d) !== JSON.stringify(saved);
  const branchOpen = d.mode === "publish" && st.pushed;

  async function save() {
    setBusy(true);
    try {
      const next = await api<GitStatus>(`/vaults/${vault.id}/git/auto`, { method: "PUT", body: { ...d, branch: d!.mode === "publish" ? d!.branch.trim() : undefined } });
      setGit(vault.id, next);
      setD(draftOf(next));
      toast(next.auto.mode === "ask" ? "Changes go to GitHub when you push" : `${MODES.find((m) => m.id === next.auto.mode)!.label}: sends as ${next.auto.sendAs?.name ?? "you"}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Sending to GitHub</h3>
      <p className="muted">
        How changes in this vault go to <code>{st.repo}</code>.{" "}
        {st.auto.mode !== "ask" && st.auto.sendAs && (
          <>
            Sent as <b>{st.auto.sendAs.name}</b>, with their GitHub token.
          </>
        )}
      </p>
      <ul className="site-features send-modes" role="radiogroup" aria-label="How changes are sent">
        {MODES.map((m) => (
          <li key={m.id}>
            <label>
              <input type="radio" name="send-mode" checked={d.mode === m.id} disabled={!isOwner || busy} onChange={() => set({ mode: m.id })} />
              <span>
                <span className="site-feature-name">{m.label}</span>
                <span className="muted">{m.help}</span>
              </span>
            </label>
            {d.mode === m.id && m.id === "publish" && (
              <div className="send-when">
                <label className="field">
                  <span className="field-label">Branch</span>
                  <input value={d.branch} onChange={(e) => set({ branch: e.target.value.replace(/\s+/g, "-") })} disabled={!isOwner || busy} spellCheck={false} autoCapitalize="off" />
                </label>
                <label className="field">
                  <span className="field-label">When</span>
                  <select value={d.soon ? "soon" : "schedule"} onChange={(e) => set({ soon: e.target.value === "soon" })} disabled={!isOwner || busy}>
                    <option value="schedule">On a schedule</option>
                    <option value="soon">Soon after edits</option>
                  </select>
                </label>
              </div>
            )}
            {d.mode === m.id && scheduled && (
              <div className="send-when">
                <label className="field">
                  <span className="field-label">Every</span>
                  <select value={d.every} onChange={(e) => set({ every: e.target.value as Draft["every"] })} disabled={!isOwner || busy}>
                    <option value="hour">Hour</option>
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                  </select>
                </label>
                {d.every === "week" && (
                  <label className="field">
                    <span className="field-label">On</span>
                    <select value={d.day} onChange={(e) => set({ day: Number(e.target.value) })} disabled={!isOwner || busy}>
                      {DAYS.map((name, i) => (
                        <option key={name} value={i}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span className="field-label">{d.every === "hour" ? "Minutes past (UK)" : "At (UK time)"}</span>
                  <input type="time" value={d.at} onChange={(e) => set({ at: e.target.value || d.at })} disabled={!isOwner || busy} />
                </label>
              </div>
            )}
            {d.mode === m.id && m.id !== "ask" && (
              <p className="muted send-when">
                {describe(d)} Notes you hold back in Review changes stay out{m.id === "publish" ? ", and deletions wait for someone to press Send now" : ""}.
              </p>
            )}
            {d.mode === m.id && toMain && (
              <p className="notice send-when" role="note">
                A push to {d.branch} often builds or deploys a site{d.soon ? `, so "soon after edits" could mean a deploy every few minutes` : ""}. If GitHub protects {d.branch}, the push is refused and the branch bar says why.
              </p>
            )}
            {d.mode === m.id && branchOpen && (
              <p className="notice send-when" role="note">
                Finish or cancel the branch {st.branch} first: publishing goes straight onto a branch, without one of its own.
              </p>
            )}
          </li>
        ))}
      </ul>
      {d.mode !== "ask" && (
        <label className="check send-credit">
          <input type="checkbox" checked={d.coauthorEmails} disabled={!isOwner || busy} onChange={(e) => set({ coauthorEmails: e.target.checked })} /> Name other editors in commits with their email (off: names only, as the repository may be public)
        </label>
      )}
      {isOwner && (
        <div className="dialog-actions">
          <button className="primary" onClick={() => void save()} disabled={busy || !changed || branchOpen || (d.mode === "publish" && !d.branch.trim())}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </section>
  );
}
