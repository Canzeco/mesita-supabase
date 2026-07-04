// Supabase Edge Function — admin-web-get-identity (natural caller)
//
// Tiny session-check called by the admin app shell. Thin per-caller door
// over _shared/identity.ts — split from the old multi-caller
// auth-get-identity EF (MESITA-54; the endpoint name IS the ACL).
//
// Local:  supabase functions serve admin-web-get-identity
// Deploy: supabase functions deploy admin-web-get-identity

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight } from "../_shared/http.ts";
import { handleGetIdentity } from "../_shared/identity.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  return await handleGetIdentity(req);
});
