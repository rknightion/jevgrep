import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { createProviderFetch } from "../src/provider-fetch.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../test/fixtures/tls/localhost-${name}.pem`, import.meta.url),
    "utf8",
  );

// Node's built-in fetch negotiates HTTP/2 when a server offers it, and a stalled
// HTTP/2 teardown in Node grew a jg process to ~200 GB. Provider traffic stays on HTTP/1.1.
test("provider requests use HTTP/1.1 even when the server offers HTTP/2", async (t) => {
  const versions: string[] = [];
  const server = createSecureServer(
    { key: fixture("key"), cert: fixture("cert"), allowHTTP1: true },
    (req, res) => {
      versions.push(req.httpVersion);
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ ok: true })));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const providerFetch = createProviderFetch({ ca: fixture("cert") });
  for (let i = 0; i < 3; i++) {
    const response = await providerFetch(`https://localhost:${port}/v1/x`, {
      method: "POST",
      body: JSON.stringify({ i }),
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.deepEqual(versions, ["1.1", "1.1", "1.1"]);
});
