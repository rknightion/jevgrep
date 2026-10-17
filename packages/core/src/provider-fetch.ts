import { Agent } from "undici";

/**
 * The fetch every provider request goes through. Node's built-in fetch negotiates HTTP/2
 * whenever a server offers it, and a stalled HTTP/2 session teardown inside Node grew a
 * jg process to ~200 GB of native memory. Provider traffic is a bounded set of JSON
 * requests, so HTTP/1.1 costs nothing that matters and keeps jg off that path.
 *
 * It stays on the global fetch, looked up per call, and only swaps the connection pool.
 */
export function createProviderFetch(connect?: { ca?: string }): typeof fetch {
  const dispatcher = new Agent({ allowH2: false, ...(connect ? { connect } : {}) });
  // @types/node types `dispatcher` with its own undici-types copy; the runtime contract is shared.
  return (input, init) =>
    globalThis.fetch(input, { ...init, dispatcher } as unknown as RequestInit);
}
