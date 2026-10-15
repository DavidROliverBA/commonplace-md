// Templates and daily notes: notes in Templates/ can be inserted or used for a
// new note, with {{title}}, {{date}} and {{time}} filled in ({{date:dddd D MMMM}} takes a
// Moment-style format, as common Templates plugins do). Daily notes live at
// Daily/YYYY-MM-DD.md and use Templates/Daily.md when there is one. Pure, so it's unit-tested.

export const TEMPLATE_FOLDER = "Templates";
export const DAILY_FOLDER = "Daily";

export const isTemplate = (path: string) => path.toLowerCase().startsWith(TEMPLATE_FOLDER.toLowerCase() + "/");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Format a date with Moment-style tokens; text in [brackets] is kept as it is. */
export function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|Do|D|HH|H|hh|h|mm|ss|A|a/g, (t, literal) => {
    if (literal !== undefined) return literal;
    const h12 = d.getHours() % 12 || 12;
    switch (t) {
      case "YYYY": return String(d.getFullYear());
      case "YY": return pad(d.getFullYear() % 100);
      case "MMMM": return MONTHS[d.getMonth()]!;
      case "MMM": return MONTHS[d.getMonth()]!.slice(0, 3);
      case "MM": return pad(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "dddd": return DAYS[d.getDay()]!;
      case "ddd": return DAYS[d.getDay()]!.slice(0, 3);
      case "DD": return pad(d.getDate());
      case "Do": return d.getDate() + ordinal(d.getDate());
      case "D": return String(d.getDate());
      case "HH": return pad(d.getHours());
      case "H": return String(d.getHours());
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(d.getMinutes());
      case "ss": return pad(d.getSeconds());
      case "A": return d.getHours() < 12 ? "AM" : "PM";
      default: return d.getHours() < 12 ? "am" : "pm";
    }
  });
}
function ordinal(n: number) {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** Fill a template's {{title}}, {{date}}, {{time}}, {{date:FORMAT}} and {{time:FORMAT}}. */
export function fillTemplate(text: string, vars: { title: string; date: Date }): string {
  return text.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_, key: string, fmt?: string) => {
    const k = key.toLowerCase();
    if (k === "title") return vars.title;
    return formatDate(vars.date, fmt?.trim() || (k === "date" ? "YYYY-MM-DD" : "HH:mm"));
  });
}

export const isoDay = (d: Date) => formatDate(d, "YYYY-MM-DD");
export const dailyPath = (d: Date) => `${DAILY_FOLDER}/${isoDay(d)}.md`;

/** The day a daily note is for, from its path, or null if it isn't one. */
export function dailyDate(path: string): Date | null {
  const m = new RegExp(`^${DAILY_FOLDER}/(\\d{4})-(\\d{2})-(\\d{2})\\.md$`, "i").exec(path);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
}

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The daily-note template's path among `paths`: Templates/Daily.md or Templates/Daily note.md. */
export function dailyTemplatePath(paths: string[]): string | undefined {
  const want = [`${TEMPLATE_FOLDER}/daily.md`, `${TEMPLATE_FOLDER}/daily note.md`].map((p) => p.toLowerCase());
  return paths.find((p) => want.includes(p.toLowerCase()));
}

/** What a new daily note contains when there's no template. */
export const defaultDaily = (d: Date) => `# ${formatDate(d, "dddd D MMMM YYYY")}\n\n`;

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** A template split into its frontmatter YAML (or null) and the rest. */
export function splitTemplate(text: string): { yaml: string | null; body: string } {
  const m = FM.exec(text);
  return m ? { yaml: m[1]!, body: text.slice(m[0].length) } : { yaml: null, body: text };
}
