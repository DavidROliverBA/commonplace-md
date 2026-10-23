// F19's schedule (src/schedule.ts): UK wall-clock times, across the clock changes.

import { describe, expect, test } from "bun:test";
import { nextRun } from "../src/schedule";

const at = (iso: string) => new Date(iso);

describe("next scheduled run, in UK time", () => {
  test("daily: later today, or tomorrow once it's passed", () => {
    expect(nextRun("day", "18:00", 0, at("2026-07-10T09:00:00Z")).toISOString()).toBe("2026-07-10T17:00:00.000Z"); // BST
    expect(nextRun("day", "18:00", 0, at("2026-07-10T17:00:00Z")).toISOString()).toBe("2026-07-11T17:00:00.000Z");
    expect(nextRun("day", "18:00", 0, at("2026-12-10T09:00:00Z")).toISOString()).toBe("2026-12-10T18:00:00.000Z"); // GMT
  });

  test("across the clocks going back and forward", () => {
    // Clocks go back at 02:00 BST on Sunday 25 October 2026.
    expect(nextRun("day", "18:00", 0, at("2026-10-24T18:00:00Z")).toISOString()).toBe("2026-10-25T18:00:00.000Z");
    // Clocks go forward at 01:00 GMT on Sunday 29 March 2026.
    expect(nextRun("day", "09:30", 0, at("2026-03-28T10:00:00Z")).toISOString()).toBe("2026-03-29T08:30:00.000Z");
  });

  test("hourly at a minute past; weekly on a day", () => {
    expect(nextRun("hour", "07:15", 0, at("2026-07-10T09:20:00Z")).toISOString()).toBe("2026-07-10T10:15:00.000Z");
    expect(nextRun("hour", "07:15", 0, at("2026-07-10T09:10:00Z")).toISOString()).toBe("2026-07-10T09:15:00.000Z");
    // Friday 17:00 UK, asked on Friday 23 October 2026 at 18:00 BST: next week.
    expect(nextRun("week", "17:00", 5, at("2026-10-23T17:00:00Z")).toISOString()).toBe("2026-10-30T17:00:00.000Z"); // GMT by then
    expect(nextRun("week", "17:00", 5, at("2026-10-23T15:00:00Z")).toISOString()).toBe("2026-10-23T16:00:00.000Z");
  });
});
