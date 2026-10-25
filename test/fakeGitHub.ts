// A fake GitHub for tests: the REST endpoints GitHub vaults use (src/github.ts), over an in-memory
// git: blobs with real git SHAs, flat trees, commits, branches and pull requests. Only the token
// TOKEN is accepted, and every request is recorded so tests can check the token never
// appears in a URL. `commitToMain` and `mergePr` play the part of someone working on GitHub; `protect`
// refuses pushes to a branch, as branch protection does.

import { createHash } from "node:crypto";

type Flat = Map<string, { sha: string; mode: string }>;

export const TOKEN = "github_pat_fake_good_token_0123456789";

const gitSha = (data: Uint8Array) => createHash("sha1").update(`blob ${data.byteLength}\0`).update(data).digest("hex");
const idOf = (kind: string, v: unknown) => createHash("sha1").update(kind + JSON.stringify(v)).digest("hex");

export function startFakeGitHub(port: number) {
  const blobs = new Map<string, Uint8Array>();
  const trees = new Map<string, Flat>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>(); // branch → commit
  const pulls: { number: number; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean }[] = [];
  const seen: { method: string; url: string; auth: string | null }[] = [];
  /** The next pull request create is refused with this, as GitHub does (e.g. 422). */
  let refusePull: { status: number; message: string } | null = null;
  /** Branches GitHub protects: a push straight to one is refused, as branch protection does. */
  const protectedBranches = new Set<string>();
  const REPO = "sam/house";

  const putBlob = (data: Uint8Array) => {
    const sha = gitSha(data);
    blobs.set(sha, data);
    return sha;
  };
  const putTree = (flat: Flat) => {
    const sha = idOf("tree", [...flat].sort((a, b) => a[0].localeCompare(b[0])));
    trees.set(sha, flat);
    return sha;
  };
  const putCommit = (tree: string, parents: string[], message: string) => {
    const sha = idOf("commit", { tree, parents, message, n: commits.size });
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  /** Files on a branch, as text. */
  const files = (branch: string) => {
    const flat = trees.get(commits.get(refs.get(branch)!)!.tree)!;
    return Object.fromEntries([...flat].map(([p, e]) => [p, new TextDecoder().decode(blobs.get(e.sha)!)]));
  };
  /** A commit on `branch` setting (string) or deleting (null) files. */
  const commitTo = (branch: string, change: Record<string, string | Uint8Array | null>, message = "edit on GitHub") => {
    const parent = refs.get(branch);
    const flat: Flat = new Map(parent ? trees.get(commits.get(parent)!.tree)! : []);
    for (const [p, v] of Object.entries(change)) {
      if (v === null) flat.delete(p);
      else flat.set(p, { sha: putBlob(typeof v === "string" ? new TextEncoder().encode(v) : v), mode: "100644" });
    }
    refs.set(branch, putCommit(putTree(flat), parent ? [parent] : [], message));
  };

  // The repo: notes in docs/, a picture, code and an app settings dot-folder that must stay untouched.
  commitTo("main", {
    "README.md": "# House\n",
    "docs/Boiler.md": "# Boiler\n\nServiced in May.\n\n- filter\n- pressure\n",
    "docs/Garden.md": "# Garden\n\nPlant bulbs.\n",
    "docs/Rooms/Kitchen.md": "# Kitchen\n\nQuartz worktops.\n",
    "docs/plan.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    "docs/.obsidian/app.json": "{}",
    "src/index.ts": "console.log('hi')\n",
  });

  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const no = (status: number, message: string) => json({ message }, status);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      seen.push({ method: req.method, url: url.pathname + url.search, auth });
      if (auth !== `Bearer ${TOKEN}`) return no(401, "Bad credentials");
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json();
      const p = url.pathname;
      let m: RegExpExecArray | null;
      if (p === "/user") return json({ login: "sam" });
      if (p === "/user/repos") return json(url.searchParams.get("page") === "1" ? [{ full_name: REPO, private: true, default_branch: "main", description: "Our house" }] : []);
      const base = `/repos/${REPO}`;
      if (!p.startsWith(base)) return no(404, "Not Found");
      const rest = p.slice(base.length);
      if (rest === "/branches") return json([...refs.keys()].map((name) => ({ name })));
      if ((m = /^\/branches\/(.+)$/.exec(rest))) {
        const sha = refs.get(decodeURIComponent(m[1]!));
        if (!sha) return no(404, "Branch not found");
        return json({ name: m[1], commit: { sha, commit: { tree: { sha: commits.get(sha)!.tree } } } });
      }
      if ((m = /^\/git\/trees\/(\w+)$/.exec(rest)) && req.method === "GET") {
        const flat = trees.get(m[1]!);
        if (!flat) return no(404, "Not Found");
        return json({ sha: m[1], truncated: false, tree: [...flat].map(([path, e]) => ({ path, mode: e.mode, type: "blob", sha: e.sha, size: blobs.get(e.sha)!.byteLength })) });
      }
      if ((m = /^\/git\/blobs\/(\w+)$/.exec(rest))) {
        const b = blobs.get(m[1]!);
        if (!b) return no(404, "Not Found");
        return json({ sha: m[1], encoding: "base64", content: Buffer.from(b).toString("base64") });
      }
      if (rest === "/git/blobs" && req.method === "POST") return json({ sha: putBlob(new Uint8Array(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"))) }, 201);
      if (rest === "/git/trees" && req.method === "POST") {
        const flat: Flat = new Map(body.base_tree ? trees.get(body.base_tree)! : []);
        for (const e of body.tree) {
          if (e.sha === null) flat.delete(e.path);
          else flat.set(e.path, { sha: e.content !== undefined ? putBlob(new TextEncoder().encode(e.content)) : e.sha, mode: e.mode });
        }
        return json({ sha: putTree(flat) }, 201);
      }
      if (rest === "/git/commits" && req.method === "POST") return json({ sha: putCommit(body.tree, body.parents, body.message) }, 201);
      if (rest === "/git/refs" && req.method === "POST") {
        const name = body.ref.replace(/^refs\/heads\//, "");
        if (refs.has(name)) return no(422, "Reference already exists");
        refs.set(name, body.sha);
        return json({ ref: body.ref }, 201);
      }
      if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
        const name = decodeURIComponent(m[1]!);
        if (req.method === "DELETE") return refs.delete(name) ? new Response(null, { status: 204 }) : no(422, "Reference does not exist");
        if (req.method === "PATCH") {
          // A fast-forward only: the new commit must descend from the branch's head.
          const head = refs.get(name);
          if (!head) return no(422, "Reference does not exist");
          if (protectedBranches.has(name)) return no(422, `Protected branch update failed for refs/heads/${name}.`);
          const descends = (c: string): boolean => c === head || (commits.get(c)?.parents ?? []).some(descends);
          if (!body.force && !descends(body.sha)) return no(422, "Update is not a fast forward");
          refs.set(name, body.sha);
          return json({ ref: name });
        }
      }
      if (rest === "/pulls" && req.method === "POST") {
        if (refusePull) {
          const r = refusePull;
          refusePull = null;
          return no(r.status, r.message);
        }
        const pr = { number: pulls.length + 1, head: body.head, base: body.base, title: body.title, body: body.body, state: "open" as const, merged: false };
        pulls.push(pr);
        return json({ number: pr.number, html_url: `https://github.com/${REPO}/pull/${pr.number}`, state: "open" }, 201);
      }
      if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
        const pr = pulls[Number(m[1]) - 1];
        if (!pr) return no(404, "Not Found");
        return json({ number: pr.number, state: pr.state, merged: pr.merged, html_url: `https://github.com/${REPO}/pull/${pr.number}` });
      }
      return no(404, "Not Found");
    },
  });

  return {
    url: `http://localhost:${port}`,
    seen,
    refs,
    pulls,
    files,
    commitToMain: (change: Record<string, string | null>) => commitTo("main", change),
    /** Commit to any branch; a branch that doesn't exist yet starts empty (an orphan, like gh-pages). */
    commitTo: (branch: string, change: Record<string, string | null>) => commitTo(branch, change),
    /** Merge PR n: main takes the branch's tree (a squash merge). */
    mergePr(n: number) {
      const pr = pulls[n - 1]!;
      const tree = commits.get(refs.get(pr.head)!)!.tree;
      refs.set(pr.base, putCommit(tree, [refs.get(pr.base)!], `Merge #${n}`));
      pr.state = "closed";
      pr.merged = true;
    },
    refuseNextPull: (status: number, message: string) => void (refusePull = { status, message }),
    protect: (branch: string, on = true) => void (on ? protectedBranches.add(branch) : protectedBranches.delete(branch)),
    parentsOf: (branch: string) => commits.get(refs.get(branch)!)!.parents,
    stop: () => server.stop(true),
  };
}
