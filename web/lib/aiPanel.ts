// The side panel's conversation (set by AiPanel), so ⌘K can turn its web on and off without
// the command list importing the panel.

import type { Conversation } from "./ai";

export const panel: { conv: Conversation | null } = { conv: null };
