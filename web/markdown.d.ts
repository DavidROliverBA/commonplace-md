// The help's pages (docs/help/*.md) are imported as text (web/lib/help.ts).
declare module "*.md" {
  const text: string;
  export default text;
}
