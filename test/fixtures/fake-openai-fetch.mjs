const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (!href.startsWith("https://fake-provider.test")) {
    return realFetch(url, init);
  }

  const body = JSON.parse(String(init?.body ?? "{}"));
  const prompt = body.messages?.at?.(-1)?.content ?? "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `model saw ${prompt}` } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};
