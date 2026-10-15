// A fake AI provider for tests: speaks Anthropic's Messages API and OpenAI's Chat Completions,
// streamed, replaying scripted replies (text and tool calls) and recording every request. Push
// replies onto `script`; once it's empty every reply is "ready". A key of "bad" is refused with
// 401. Also serves relaxAI-style `/embeddings` (4096 dims, not unit length).

export type Reply = { text?: string; calls?: { name: string; input: object }[] };

export function startFakeAi(port: number) {
  const script: Reply[] = [];
  const seen: { path: string; headers: Record<string, string>; body: any }[] = [];
  let n = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.json() });
      if (req.headers.get("x-api-key") === "bad" || req.headers.get("authorization") === "Bearer bad") return Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 });
      if (url.pathname.endsWith("/embeddings")) {
        // relaxAI-style: 4096 dims, not unit length, so truncation and rescaling are tested.
        const body = seen[seen.length - 1]!.body;
        const data = (body.input as string[]).map((t, index) => ({ index, embedding: Array.from({ length: 4096 }, (_, i) => ((t.length * (i + 1)) % 7) + (i < 1024 ? 3 : 0)) }));
        return Response.json({ data, usage: { prompt_tokens: 10, total_tokens: 10 } });
      }
      const r = script.shift() ?? { text: "ready" };
      const calls = (r.calls ?? []).map((c) => ({ ...c, id: `call_${++n}` }));
      const stream = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.endsWith("/chat/completions")) {
        const chunks: object[] = [];
        if (r.text) chunks.push({ choices: [{ delta: { content: r.text } }] });
        calls.forEach((c, i) => {
          const args = JSON.stringify(c.input);
          chunks.push({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: args.slice(0, 5) } }] } }] });
          chunks.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(5) } }] } }] });
        });
        chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
        chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        return stream(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
      }
      const events: object[] = [{ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } }];
      let i = 0;
      if (r.text) {
        events.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
        for (const part of r.text.match(/.{1,6}/gs)!) events.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } });
        events.push({ type: "content_block_stop", index: i++ });
      }
      for (const c of calls) {
        const args = JSON.stringify(c.input);
        events.push({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
        events.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: args.slice(0, 7) } });
        events.push({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: args.slice(7) } });
        events.push({ type: "content_block_stop", index: i++ });
      }
      events.push({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
      events.push({ type: "message_stop" });
      return stream(events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    },
  });
  return { script, seen, url: `http://localhost:${port}`, stop: () => server.stop(true) };
}
