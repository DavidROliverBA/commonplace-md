// The bar on a GitHub vault (F14): always there, on the laptop and the iPhone, saying which branch
// the edits are on and how many notes changed, with the next step one tap away: review the
// changes, open the pull request (or push more to it), and in its menu update from the base
// branch or cancel the branch. When changes go on their own (F19), a second line says what's
// next ("Next PR at 18:00 · 3 changes waiting · sends as Sam"), with Send now and Pause.
// On a phone it sits at the top of the Files drawer instead, so the note gets the whole screen,
// and `filesBadge` puts a dot on the Files button when something there wants you.

import type { Vault } from "../lib/api";
import { autoLine, cancelBranch, changedLabel, type GitStatus, sendNow, setPaused, updateFromBase } from "../lib/git";
import { navigate } from "../lib/router";
import { openSettings } from "../lib/settings";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import type { ToggleBadge } from "../ui/PanelToggle";

interface Props {
  vault: Vault;
  status: GitStatus | null;
  onPullRequest: () => void;
  /** After a step that leaves the bar (closes the drawer on a phone). */
  onNavigate?: () => void;
}

/** What the Files button's dot says when the bar is in the drawer; null when all's quiet. */
export function filesBadge(st: GitStatus | null): ToggleBadge | null {
  if (!st) return null;
  if (st.clashes.length) return { text: `${st.clashes.length} to settle on GitHub`, warn: true };
  if (st.auto.paused) return { text: "sending to GitHub paused", warn: true };
  if (st.unpushed || st.auto.waiting || (!st.pushed && st.changes.length)) return { text: "changes not on GitHub yet" };
  return null;
}

export function BranchBar({ vault, status: st, onPullRequest: openPr, onNavigate = () => {} }: Props) {
  if (!st) return <div className="branch-bar" aria-busy="true" />;
  const canWrite = vault.role !== "viewer";
  const review = () => (navigate(`/v/${vault.id}/changes`), onNavigate());
  const onPullRequest = () => (onNavigate(), openPr());
  const auto = st.auto.mode !== "ask";
  const publishing = st.auto.mode === "publish";
  const line = autoLine(st);
  let action: { label: string; short: string; run: () => void } | null = null;
  if (canWrite && auto) {
    if (!st.clashes.length && (st.auto.waiting || st.auto.deletionsWaiting || (!publishing && st.unpushed))) action = { label: "Send now", short: "Send", run: () => void sendNow(vault.id, st) };
  } else if (canWrite && st.pr?.state !== "merged") {
    if (!st.pushed && st.changes.length) action = { label: "Open pull request", short: "Open PR", run: onPullRequest };
    else if (st.pushed && st.unpushed) action = { label: `Push ${st.unpushed} more change${st.unpushed === 1 ? "" : "s"}`, short: `Push ${st.unpushed}`, run: onPullRequest };
  }

  return (
    <div className="branch-bar" role="region" aria-label="GitHub branch">
      <Icon name="branch" size={16} />
      <div className="branch-what">
        <span className="branch-line">
          {publishing ? (
            <>
              Publishing to <code>{st.baseBranch}</code> <span className="branch-from">{st.repo}</span>
            </>
          ) : st.pushed || st.changes.length ? (
            <>
              On <code>{st.branch}</code> <span className="branch-from">from {st.baseBranch}</span>
            </>
          ) : (
            <>
              <code>{st.repo}</code> <span className="branch-from">{st.baseBranch}</span>
            </>
          )}
        </span>
        <button className="link branch-count" onClick={review}>
          {changedLabel(st)}
          {st.clashes.length > 0 && <span className="branch-clash"> · {st.clashes.length} to settle</span>}
        </button>
        {line && (
          <span className={`branch-auto${st.auto.paused ? " paused" : ""}`} role="status">
            <Icon name={st.auto.paused ? "pause" : "clock"} size={12} /> {line}
            {st.auto.paused && st.auto.paused.by !== "clashes" && canWrite && (
              <button className="link" onClick={() => (st.auto.paused!.by === "sender" ? openSettings("vault") : void setPaused(vault.id, false))}>
                {st.auto.paused.by === "sender" ? "Choose again" : "Carry on"}
              </button>
            )}
          </span>
        )}
      </div>
      {st.pr && (
        <a className={`branch-pr pr-${st.pr.state}`} href={st.pr.url} target="_blank" rel="noopener noreferrer" title={`Pull request #${st.pr.number} on GitHub`}>
          <Icon name="pull-request" size={14} /> #{st.pr.number} <span className="pr-state">{st.pr.state}</span>
        </a>
      )}
      <button className="quiet only-wide" onClick={review}>
        Review changes
      </button>
      {action && (
        <button className="primary" onClick={action.run} aria-label={action.label}>
          <span className="only-wide">{action.label}</span>
          <span className="only-narrow">{action.short}</span>
        </button>
      )}
      <Menu
        label="Branch"
        items={() => [
          { label: "Review changes", icon: "edit", onSelect: review },
          { label: "Send now", icon: "upload", hidden: !canWrite || !auto, onSelect: () => void sendNow(vault.id, st) },
          { label: st.auto.paused ? "Carry on with automatic pushes" : "Pause automatic pushes", icon: st.auto.paused ? "play" : "pause", hidden: !canWrite || !auto || st.auto.paused?.by === "clashes" || st.auto.paused?.by === "sender", onSelect: () => void setPaused(vault.id, !st.auto.paused) },
          { label: "How changes are sent…", icon: "settings", onSelect: () => openSettings("vault") },
          { label: `Update from ${st.baseBranch}`, icon: "download", hidden: !canWrite, onSelect: () => void updateFromBase(vault.id, st) },
          { label: "Open on GitHub", icon: "link", href: `https://github.com/${st.repo}${st.pushed ? `/tree/${st.branch}` : ""}`, external: true },
          { label: "Cancel the branch", icon: "undo", danger: true, hidden: !canWrite || (!st.changes.length && !st.pushed), onSelect: () => void cancelBranch(vault.id, st) },
        ]}
      />
    </div>
  );
}
