// GitHub vaults (F14): connecting your own GitHub token (Settings → Connections, which the first
// step of "New vault from GitHub" opens), and picking a repo, branch and folder to copy in.

import { useEffect, useState } from "react";
import { api, type Vault } from "../lib/api";
import { navigate } from "../lib/router";
import { openSettings } from "../lib/settings";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { confirmDialog, toast, toastError } from "../ui/overlays";

interface Connection {
  login: string;
  token_hint: string;
}
interface Repo {
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
}

const NEW_TOKEN = "https://github.com/settings/personal-access-tokens/new";

// Every screen showing the connection, so connecting in Settings updates the dialog beneath it.
const watchers = new Set<() => void>();

/** Your GitHub connection (null while loading); reload() refreshes every screen showing it. */
export function useGitHub() {
  const [state, setState] = useState<{ available: boolean; connection: Connection | null } | null>(null);
  useEffect(() => {
    const load = () => void api<{ available: boolean; connection: Connection | null }>("/me/github").then(setState, toastError);
    load();
    watchers.add(load);
    return () => void watchers.delete(load);
  }, []);
  return { state, reload: () => watchers.forEach((f) => f()) };
}

/** Paste a token: checked with GitHub, then kept sealed on the server and never shown again. */
function ConnectForm({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="github-connect"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const c = await api<Connection>("/me/github", { method: "PUT", body: { token } });
          toast(`Connected to GitHub as ${c.login}`);
          setToken("");
          onDone();
        } catch (err) {
          toastError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ol className="steps">
        <li>
          On GitHub, make a{" "}
          <a href={NEW_TOKEN} target="_blank" rel="noopener noreferrer">
            fine-grained personal access token
          </a>{" "}
          for just the repositories you want here.
        </li>
        <li>
          Under <i>Repository permissions</i>, give it <b>Contents</b> and <b>Pull requests</b>: read and write.
        </li>
        <li>Paste it here. It's checked with GitHub, stored encrypted, and never shown again.</li>
      </ol>
      <div className="row">
        <input value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="github_pat_…" aria-label="GitHub token" autoComplete="off" spellCheck={false} type="password" />
        <button type="submit" className="primary" disabled={busy || token.length < 20}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
    </form>
  );
}

/** Settings → Connections → GitHub. */
export function GitHubAccount() {
  const { state, reload } = useGitHub();
  if (!state) return null;
  return (
    <section className="settings-section">
      <h3>GitHub</h3>
      <p className="muted">Open a repository of markdown as a vault: edit it here, then send your changes back as a pull request. Uses your own token; nothing reaches the main branch without a PR.</p>
      {!state.available ? (
        <p className="notice">This server can't store tokens yet: an admin needs to set SECRETS_KEY.</p>
      ) : state.connection ? (
        <ul className="members">
          <li>
            <div>
              <Icon name="branch" size={16} /> <b>{state.connection.login}</b> <span className="muted">· token …{state.connection.token_hint}</span>
            </div>
            <button
              className="danger-link"
              onClick={async () => {
                if (!(await confirmDialog({ title: "Disconnect GitHub?", message: "Your GitHub vaults stay, but can't push, update or open pull requests until you connect again. Revoke the token on GitHub too if you're done with it.", action: "Disconnect", danger: true }))) return;
                await api("/me/github", { method: "DELETE" }).catch(toastError);
                void reload();
              }}
            >
              Disconnect
            </button>
          </li>
        </ul>
      ) : (
        <ConnectForm onDone={() => void reload()} />
      )}
    </section>
  );
}

/** New vault from GitHub: connect if needed, then repo → branch → folder → copy in. */
export function GitHubVaultDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (v: Vault) => Promise<unknown> }) {
  const { state } = useGitHub();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [folders, setFolders] = useState<{ folder: string; notes: number }[] | null>(null);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = !!state?.connection;

  useEffect(() => {
    if (connected) api<Repo[]>("/me/github/repos").then((r) => (setRepos(r), r[0] && pickRepo(r[0])), toastError);
  }, [connected]);

  function pickRepo(r: Repo) {
    setRepo(r.full_name);
    setBranch(r.default_branch);
    setBranches([r.default_branch]);
    setFolders(null);
    setFolder("");
    api<string[]>(`/me/github/repos/${r.full_name}/branches`).then(setBranches, toastError);
  }
  useEffect(() => {
    if (!repo || !branch) return;
    setFolders(null);
    api<{ folder: string; notes: number }[]>(`/me/github/repos/${repo}/folders?branch=${encodeURIComponent(branch)}`).then((f) => {
      setFolders(f);
      setFolder((cur) => (f.some((x) => x.folder === cur) ? cur : ""));
    }, toastError);
  }, [repo, branch]);

  const chosen = folders?.find((f) => f.folder === folder);
  const defaultName = repo ? (folder ? `${repo.split("/")[1]} / ${folder}` : repo.split("/")[1]!) : "";

  async function create() {
    setBusy(true);
    try {
      const r = await api<{ vault: Vault; notes: number; files: number; skipped: { path: string; why: string }[] }>("/vaults/github", { body: { repo, branch, folder, name: name.trim() || undefined } });
      toast(`Copied ${r.notes} note${r.notes === 1 ? "" : "s"}${r.files ? ` and ${r.files} file${r.files === 1 ? "" : "s"}` : ""} from ${repo}${r.skipped.length ? `; ${r.skipped.length} skipped (too large or a clashing name)` : ""}`);
      await onCreated(r.vault); // the vault list first, or the app won't know the new vault yet
      navigate(`/v/${r.vault.id}`);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New vault from GitHub" onClose={onClose}>
      {!state ? (
        <div className="loading-bar" />
      ) : !state.available ? (
        <p className="notice">This server can't store GitHub tokens yet: an admin needs to set SECRETS_KEY.</p>
      ) : !connected ? (
        <>
          <p className="muted">First, connect GitHub with a token of your own. It's kept in Settings → Connections, where you can disconnect it later.</p>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={() => openSettings("connections")}>
              Connect GitHub…
            </button>
          </div>
        </>
      ) : (
        <form
          className="assistant-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <p className="muted">
            The notes and pictures are copied in; code, app settings folders (dot-folders) and everything else stay on GitHub, untouched. Your edits become a branch, and you finish with a pull request.
          </p>
          <label className="field">
            <span className="field-label">Repository</span>
            <select value={repo} onChange={(e) => pickRepo(repos!.find((r) => r.full_name === e.target.value)!)} disabled={!repos?.length} aria-label="Repository">
              {!repos && <option>Loading…</option>}
              {repos?.length === 0 && <option>The token can't see any repositories</option>}
              {repos?.map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                  {r.private ? " (private)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="row wrap">
            <label className="field grow">
              <span className="field-label">Branch</span>
              <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch">
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span className="field-label">Folder</span>
              <select value={folder} onChange={(e) => setFolder(e.target.value)} disabled={!folders} aria-label="Folder">
                {!folders && <option>Looking…</option>}
                {folders?.map((f) => (
                  <option key={f.folder} value={f.folder}>
                    {f.folder || "The whole repository"} ({f.notes} note{f.notes === 1 ? "" : "s"})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field-label">Vault name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} maxLength={200} />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || !repo || !chosen || !chosen.notes}>
              {busy ? "Copying…" : chosen ? `Copy ${chosen.notes} note${chosen.notes === 1 ? "" : "s"} in` : "Copy in"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
