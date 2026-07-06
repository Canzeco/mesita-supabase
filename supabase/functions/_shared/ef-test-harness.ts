// Shared test harness for Edge Function smoke tests (MESITA-142).
//
// Money-path EFs are self-contained `Deno.serve(handler)` modules. To smoke
// test their request/response CONTRACT (method gate, auth gate, input
// validation) offline — no port bound, no DB, no Stripe — we intercept
// `Deno.serve` before importing the module so we capture the handler function
// instead of starting a real server, then invoke it with crafted `Request`s.
//
// This exercises the real production handler unchanged (the EF code is never
// modified); we only substitute the runtime's `Deno.serve` with a capture
// shim for the duration of the import.

export type EFHandler = (req: Request) => Response | Promise<Response>;

// Dummy env the guard chain needs to advance PAST readEFEnv() to the auth
// check. A missing-bearer request returns 401 before any of these values are
// used to construct a client, so they are never dereferenced against a real
// backend — they exist only so readEFEnv() doesn't short-circuit with a 500.
const DUMMY_ENV: Record<string, string> = {
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
};

/** Set the dummy Supabase env vars used by the guard chain. Idempotent. */
export function setDummyEnv(extra: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries({ ...DUMMY_ENV, ...extra })) {
    Deno.env.set(k, v);
  }
}

// Loads an EF handler by intercepting Deno.serve during the module import.
// The path is resolved relative to THIS harness file (which lives in
// `_shared/`), so EFs one level up are addressed as
// `../business-web-create-ticket/index.ts`.
export async function loadEFHandler(modulePath: string): Promise<EFHandler> {
  const original = Deno.serve;
  let captured: EFHandler | null = null;

  // The EFs call the single-arg form `Deno.serve(handler)`. We only need to
  // capture that handler; the returned server object is never used by the
  // handler itself, so a minimal stand-in is enough to satisfy the call.
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (
    arg1: unknown,
    arg2?: unknown,
  ): unknown => {
    // Deno.serve(handler) OR Deno.serve(options, handler).
    const handler = (typeof arg1 === "function" ? arg1 : arg2) as EFHandler;
    captured = handler;
    // Return a no-op server-shaped object so nothing at import time throws.
    return {
      finished: Promise.resolve(),
      shutdown: () => Promise.resolve(),
      ref: () => {},
      unref: () => {},
      addr: { transport: "tcp", hostname: "localhost", port: 0 },
    };
  };

  try {
    // Cache-bust so re-importing the same module in one test run re-captures.
    await import(`${modulePath}?h=${crypto.randomUUID()}`);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = original;
  }

  if (!captured) {
    throw new Error(`No Deno.serve handler captured from ${modulePath}`);
  }
  return captured;
}

/** Build a JSON POST request with an optional bearer token. */
export function jsonRequest(
  body: unknown,
  init: { method?: string; bearer?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  };
  if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;
  return new Request("http://ef.local/", {
    method: init.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Read a JSON response body, tolerating plain-text (webhook) responses. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
