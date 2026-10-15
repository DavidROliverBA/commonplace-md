// The one test for "is this the phone layout?", shared by App, Menu, Settings, NoteView and TypePage
// so JavaScript and CSS switch at the same width.

import { useEffect, useState } from "react";

/** The phone layout's breakpoint; matches `@media (max-width: 820px)` in styles/phone.css. */
export const NARROW = "(max-width: 820px)";

/** True while the window is phone-width (drawers, bottom sheets). */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
