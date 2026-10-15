// Calling addresses people give the server (weblinks in src/weblinks.ts, assistants' base URLs in
// src/llm.ts) without being turned against what only the server can reach (SSRF), DNS rebinding
// included. A name is resolved once, every address it gives is checked (src/addresses.ts), and the
// connection goes to one of those checked addresses: `fetch` is given the address itself, with the
// Host header and the TLS server name (SNI, and the name the certificate is checked against) set to
// the original name, so a name that answers with a public address first and a private one later
// never gets a second lookup. Bun's fetch checks the certificate against `tls.serverName` (verified
// in test/capture.test.ts against a real TLS server), so https stays as strict as for the name.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "./addresses";

/** A name's addresses. Injected in tests; the system resolver otherwise. */
export type Resolve = (host: string) => Promise<string[]>;
export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export class EgressError extends Error {
  constructor(
    public reason: "unresolved" | "private",
    message: string,
  ) {
    super(message);
  }
}

/** The host of a URL without IPv6 brackets. */
export const bareHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "");

/** The addresses to connect to for `url`, each checked: refused if any is private (unless
 *  `allowPrivate`, for tests and local models), so a name can't mix a public address with an
 *  internal one. An IP literal is its own address and needs no lookup. */
export async function vetAddresses(url: URL, opts: { allowPrivate?: boolean; resolve?: Resolve } = {}): Promise<string[]> {
  const host = bareHost(url);
  const addrs = isIP(host) ? [host] : await (opts.resolve ?? systemResolve)(host).catch(() => [] as string[]);
  if (!addrs.length) throw new EgressError("unresolved", `Couldn't find ${host}`);
  if (!opts.allowPrivate && addrs.some((a) => isPrivateAddress(a))) throw new EgressError("private", "That address isn't on the public web");
  return addrs;
}

/** `url` with its host replaced by `address`, and what keeps the request about the original name:
 *  the Host header and, for https to a name, the TLS server name. */
export function pinnedTarget(url: URL, address: string): { url: string; host: string; serverName?: string } {
  const to = new URL(url);
  to.hostname = isIP(address) === 6 ? `[${address}]` : address;
  const name = bareHost(url);
  return { url: to.toString(), host: url.host, serverName: url.protocol === "https:" && !isIP(name) ? name : undefined };
}

type Fetch = (input: string, init: BunFetchRequestInit) => Promise<Response>;

/** Fetch `url`, connecting only to `addresses` (the next one if a connection fails, as a browser
 *  would), never resolving the name again. Redirects are the caller's: pass `redirect: "manual"`
 *  or `"error"`, and vet and pin each hop. */
export async function pinnedFetch(url: URL, addresses: string[], init: BunFetchRequestInit = {}, doFetch: Fetch = fetch as Fetch): Promise<Response> {
  if (init.redirect !== "manual" && init.redirect !== "error") throw new Error("pinnedFetch: follow redirects yourself, so each hop is checked");
  let last: unknown = new EgressError("unresolved", `Couldn't find ${bareHost(url)}`);
  for (const address of addresses) {
    const t = pinnedTarget(url, address);
    const headers = new Headers(init.headers);
    headers.set("host", t.host);
    try {
      return await doFetch(t.url, { ...init, headers, tls: t.serverName ? { ...init.tls, serverName: t.serverName } : init.tls });
    } catch (e) {
      if (init.signal?.aborted) throw e;
      last = e;
    }
  }
  throw last;
}
