// A note's script with an endless loop would freeze the tab when the browser runs the sandbox in
// the page's own process, and nothing outside the loop could stop it. So before it runs, every
// loop gets a call at the top of its body (`__dvGuard()`), which throws once the script has held
// the thread for too long without letting the page breathe (web/sandbox/dvjs.ts keeps the time).

import { parse } from "acorn";

export const GUARD = "__dvGuard";

const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

interface Node {
  type: string;
  start: number;
  end: number;
  body?: Node | Node[];
  [k: string]: unknown;
}

/** The code of an async function body, with each loop's body starting with a guard call. Code
 *  that doesn't parse comes back as it was, so running it gives the usual syntax error. */
export function guardLoops(code: string): string {
  // Parsed as the body it becomes, so `await` and `return` at the top are allowed.
  const head = "(async () => {\n";
  const src = `${head}${code}\n})`;
  let ast: Node;
  try {
    ast = parse(src, { ecmaVersion: "latest", sourceType: "script" }) as unknown as Node;
  } catch {
    return code;
  }
  const edits: { at: number; text: string }[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const node = n as Node;
    if (typeof node.type !== "string") return;
    if (LOOPS.has(node.type) && node.body && !Array.isArray(node.body)) {
      const b = node.body;
      if (b.type === "BlockStatement") edits.push({ at: b.start + 1, text: `${GUARD}();` });
      else edits.push({ at: b.start, text: `{${GUARD}();` }, { at: b.end, text: "}" });
    }
    for (const k in node) if (k !== "type" && k !== "start" && k !== "end") walk(node[k]);
  };
  walk(ast);
  let out = src;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out.slice(head.length, out.length - "\n})".length);
}
