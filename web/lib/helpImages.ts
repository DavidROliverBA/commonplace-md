// Where the help's pictures come from in the app: the server's /help/images/ (src/server.ts). The
// standalone build swaps this module for one with the pictures inside the file
// (standalone/build.ts). An absolute address, so the renderer leaves it alone.

export const HELP_STANDALONE = false;
export const helpImageUrl = (name: string) => `${location.origin}/help/images/${name}`;
