// The bar on a GitHub vault (F14): always there, on the laptop and the iPhone, saying which branch
// the edits are on and how many notes changed, with the next step one tap away: review the
// changes, open the pull request (or push more to it), and in its menu update from the base
// branch or cancel the branch.

import type { Vault } from "../lib/api";
import { cancelBranch, changedLabel, type GitStatus, updateFromBase } from "../lib/git";
import { navigate } from "../lib/router";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";

interface Props {
  vault: Vault;
  status: GitStatus | null;
  onPullRequest: () => void;
}

export function BranchBar({ vault, status: st, onPullRequest }: Props) {
  if (!st) return <div className="branch-bar" aria-busy="true" />;
  const canWrite = vault.role !== "viewer";
  const review = () => navigate(`/v/${vault.id}/changes`);
  let action: { label: string; short: string } | null = null;
  if (canWrite && st.pr?.state !== "merged") {
    if (!st.pushed && st.changes.length) action = { label: "Open pull request", short: "Open PR" };
    else if (st.pushed && st.unpushed) action = { label: `Push ${st.unpushed} more change${st.unpushed === 1 ? "" : "s"}`, short: `Push ${st.unpushed}` };
  }

  return (
    <div className="branch-bar" role="region" aria-label="GitHub branch">
      <Icon name="branch" size={16} />
      <div className="branch-what">
        <span className="branch-line">
          {st.pushed || st.changes.length ? (
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
        <button className="primary" onClick={onPullRequest} aria-label={action.label}>
          <span className="only-wide">{action.label}</span>
          <span className="only-narrow">{action.short}</span>
        </button>
      )}
      <Menu
        label="Branch"
        items={() => [
          { label: "Review changes", icon: "edit", onSelect: review },
          { label: `Update from ${st.baseBranch}`, icon: "download", hidden: !canWrite, onSelect: () => void updateFromBase(vault.id, st) },
          { label: "Open on GitHub", icon: "link", href: `https://github.com/${st.repo}${st.pushed ? `/tree/${st.branch}` : ""}`, external: true },
          { label: "Cancel the branch", icon: "undo", danger: true, hidden: !canWrite || (!st.changes.length && !st.pushed), onSelect: () => void cancelBranch(vault.id, st) },
        ]}
      />
    </div>
  );
}
