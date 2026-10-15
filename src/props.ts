// Setting a note's properties as text: shared by the AI tools, the type pages' PATCH and renames.

import { deleteProp, setProp } from "../web/lib/frontmatter";

const FM = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** A note's text with some properties set (null removes one), everything else untouched. */
export function withProperties(cur: string, props: Record<string, unknown>): string {
  const m = FM.exec(cur);
  let yaml = m ? m[1]! : "";
  for (const [k, val] of Object.entries(props)) yaml = val === null ? deleteProp(yaml, k) : setProp(yaml, k, val as any);
  const body = m ? cur.slice(m[0].length) : cur;
  return yaml.trim() ? `---\n${yaml.replace(/\s*$/, "")}\n---\n${body}` : body;
}

