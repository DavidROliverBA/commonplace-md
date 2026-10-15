// What AI models cost, in £ per million tokens, so every conversation can say what it cost and
// each assistant can have a daily £ limit (F13). Shared with the browser, so keep it free of
// server imports. An assistant can override these (models we don't know, price changes).
//
// Verified 2026-10-11: relaxAI from relax.ai/docs/getting-started/pricing (published in £);
// Anthropic from claude.com/pricing and OpenAI from developers.openai.com/api/docs/pricing (in $,
// converted at USD_GBP). Update this table, and the date, when prices change.

export const USD_GBP = 0.75; // late July 2026

export interface Price {
  /** £ per million input tokens. */
  in: number;
  /** £ per million output tokens. */
  out: number;
}

const usd = (inUsd: number, outUsd: number): Price => ({ in: +(inUsd * USD_GBP).toFixed(4), out: +(outUsd * USD_GBP).toFixed(4) });

export const PRICES: Record<"anthropic" | "openai" | "relaxai", Record<string, Price>> = {
  anthropic: {
    "claude-fable-5-1": usd(10, 50),
    "claude-opus-5-5": usd(4, 20),
    "claude-sonnet-5-5": usd(2, 10),
    "claude-haiku-5-5": usd(0.1, 0.5), // prompts up to 100k tokens; longer ones cost 5×
  },
  openai: {
    "gpt-6-astra": usd(10, 50),
    "gpt-6.1-sol": usd(2, 10),
    "gpt-6-sol": usd(2, 10),
    "gpt-6-luna": usd(0.1, 0.5),
    "gpt-5.6-sol": usd(4, 20),
    "gpt-5.5": usd(5, 30),
    "gpt-5.4": usd(2.5, 15),
    "gpt-5.4-mini": usd(0.75, 4.5),
    "gpt-5": usd(1.25, 10),
    "gpt-5-mini": usd(0.25, 2),
  },
  relaxai: {
    "DeepSeek-V4-Pro": { in: 1.17, out: 2.33 },
    "Nemotron-3-Super": { in: 0.22, out: 0.67 },
    "DeepSeek-V41-Flash": { in: 0.18, out: 0.72 },
    "Muse-Glimmer-30B": { in: 0.18, out: 0.66 },
  },
};

/** The list price of a provider's model, if we know it. */
export function listPrice(provider: string, model: string): Price | null {
  return (PRICES as Record<string, Record<string, Price>>)[provider]?.[model.trim()] ?? null;
}

export interface TokenUse {
  /** Input tokens at the full price. */
  input: number;
  output: number;
  /** Input read from the provider's prompt cache: a tenth of the input price. */
  cacheRead?: number;
  /** Input written to Anthropic's prompt cache: 1.25× the input price. */
  cacheWrite?: number;
}

/** £ for some tokens at a price. */
export function costOf(p: Price, u: TokenUse): number {
  return (u.input * p.in + (u.cacheRead ?? 0) * p.in * 0.1 + (u.cacheWrite ?? 0) * p.in * 1.25 + u.output * p.out) / 1e6;
}

/** "£0.03", or "under 1p". */
export function pounds(n: number): string {
  return n > 0 && n < 0.005 ? "under 1p" : `£${n.toFixed(2)}`;
}
