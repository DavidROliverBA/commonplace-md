// When a scheduled automatic push runs (F19): hourly at :MM, daily at HH:MM or weekly on a day,
// all in UK time across the clock changes. Pure, so the browser could share it and tests need no
// database.

export type Every = "hour" | "day" | "week";

const LONDON = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });

function wall(t: number) {
  const p = Object.fromEntries(LONDON.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}
/** The instant a London wall-clock time happens (across the clock changes). */
function fromWall(y: number, m: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t: number) => {
    const w = wall(t);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000;
  };
  return guess - offset(guess - offset(guess));
}

/** The next scheduled run after `from`: hourly at :MM, daily at HH:MM, or weekly on `day` (0 = Sunday). */
export function nextRun(every: Every, at: string, day: number, from = new Date()): Date {
  const [h, mi] = at.split(":").map(Number) as [number, number];
  const now = from.getTime();
  const w = wall(now);
  if (every === "hour") {
    let t = fromWall(w.y, w.m, w.d, w.h, mi);
    while (t <= now) t += 3_600_000;
    return new Date(t);
  }
  for (let i = 0; i <= 8; i++) {
    const d = new Date(Date.UTC(w.y, w.m - 1, w.d + i));
    if (every === "week" && d.getUTCDay() !== day) continue;
    const t = fromWall(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
    if (t > now) return new Date(t);
  }
  throw new Error("no next run"); // unreachable: a week always has the day
}

