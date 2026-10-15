// Which network addresses the server must never be made to call on someone's behalf: the guard
// against server-side request forgery for weblink fetches (src/weblinks.ts) and assistants' base
// URLs (src/assistants.ts). Pure, so it's unit-tested on its own.

import { isIP } from "node:net";

/** An address the server must not fetch: loopback, private, link-local (metadata), CGNAT,
 *  benchmarking, reserved, multicast, and any IPv6 form that carries one of those IPv4
 *  addresses inside it (mapped `::ffff:7f00:1`, compatible `::7f00:1`, NAT64, 6to4). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(v) === 4) {
    const [a, b, c] = v.split(".").map(Number) as [number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (isIP(v) !== 6) return true; // not an address at all
  const h = ipv6Hextets(v);
  if (!h) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(5) && h[5] === 0xffff) return isPrivateAddress(v4(h[6]!, h[7]!)); // ::ffff:a.b.c.d
  if (zeros(6)) return h[6] === 0 && h[7]! <= 1 ? true : isPrivateAddress(v4(h[6]!, h[7]!)); // ::, ::1, ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(0)) return isPrivateAddress(v4(h[6]!, h[7]!)); // NAT64
  if (h[0] === 0x2002) return isPrivateAddress(v4(h[1]!, h[2]!)); // 6to4
  return (h[0]! & 0xfe00) === 0xfc00 || (h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xff00) === 0xff00; // ULA, link-local, multicast
}

/** The eight 16-bit groups of an IPv6 address (with `::` expanded and a dotted IPv4 tail split). */
function ipv6Hextets(v: string): number[] | null {
  let s = v;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail[1]!.split(".").map(Number) as [number, number, number, number];
    s = s.slice(0, -tail[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const parts = [...left, ...Array(fill).fill("0"), ...right];
  if (parts.length !== 8) return null;
  const out = parts.map((p) => parseInt(p, 16));
  return out.every((n) => n >= 0 && n <= 0xffff) ? out : null;
}
