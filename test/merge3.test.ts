// Three-way line merge (src/merge3.ts), used when a GitHub vault takes in changes from GitHub:
// clean merges, and the clashes that must not merge. Pure function, no database needed.

import { describe, expect, test } from "bun:test";
import { merge3 } from "../src/merge3";

describe("merge3", () => {
  const base = "# Boiler\n\nServiced in May.\n\n- filter\n- pressure\n\nEnd";
  test("changes to different lines both land", () => {
    const ours = base.replace("Serviced in May.", "Serviced in May by Sam.");
    const theirs = base.replace("- pressure", "- pressure\n- flue");
    expect(merge3(base, ours, theirs)).toEqual({ clean: true, text: "# Boiler\n\nServiced in May by Sam.\n\n- filter\n- pressure\n- flue\n\nEnd" });
  });
  test("one side unchanged takes the other", () => {
    const theirs = base + "\nmore";
    expect(merge3(base, base, theirs)).toEqual({ clean: true, text: theirs });
    expect(merge3(base, theirs, base)).toEqual({ clean: true, text: theirs });
  });
  test("the same change on both sides is no clash", () => {
    const both = base.replace("May", "June");
    expect(merge3(base, both, both)).toEqual({ clean: true, text: both });
  });
  test("different changes to the same line clash", () => {
    expect(merge3(base, base.replace("May", "June"), base.replace("May", "July")).clean).toBe(false);
  });
  test("edits at the start and the end, and deletions", () => {
    const ours = base.replace("# Boiler", "# Boiler notes");
    const theirs = base.replace("\n\nEnd", "");
    expect(merge3(base, ours, theirs)).toEqual({ clean: true, text: "# Boiler notes\n\nServiced in May.\n\n- filter\n- pressure" });
  });
  test("an empty base (added on both sides) merges only when equal", () => {
    expect(merge3("", "a", "a").clean).toBe(true);
    expect(merge3("", "a", "b").clean).toBe(false);
  });
});
