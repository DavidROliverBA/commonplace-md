// Embedding providers, against the fake relaxAI in test/fakeAi.ts (on port 3193). No database
// needed.

import { afterAll, describe, expect, test } from "bun:test";
import { DIMS, embedTexts, providerName } from "../src/embed";
import { settings } from "../src/settings";
import { startFakeAi } from "./fakeAi";

describe("relaxAI embeddings", () => {
  const fake = startFakeAi(3193);
  const saved = { ...settings };
  afterAll(() => {
    Object.assign(settings, saved);
    fake.stop();
  });

  test("Mistral-7b-embedding's 4096 dims are cut to 1024 and scaled to unit length; the key goes in a header", async () => {
    Object.assign(settings, { embeddingProvider: "relaxai", relaxApiKey: "fake-relax", relaxBaseUrl: `${fake.url}/v1` });
    expect(providerName()).toBe("relaxai-mistral-7b-1024");
    const [a, b] = await embedTexts(["boiler service", "pancakes"], "document");
    expect(a!.length).toBe(DIMS);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 9);
    expect(a).not.toEqual(b);
    const req = fake.seen.at(-1)!;
    expect(req.path).toBe("/v1/embeddings");
    expect(req.body).toEqual({ input: ["boiler service", "pancakes"], model: "Mistral-7b-embedding" });
    expect(req.headers.authorization).toBe("Bearer fake-relax");
  });

  test("without a key it says which one it needs", async () => {
    Object.assign(settings, { embeddingProvider: "relaxai", relaxApiKey: "" });
    await expect(embedTexts(["x"], "query")).rejects.toThrow("needs RELAX_API_KEY");
  });
});
