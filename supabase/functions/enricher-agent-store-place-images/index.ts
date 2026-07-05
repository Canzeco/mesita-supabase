// Supabase Edge Function — enricher-agent-store-place-images (artificial caller / async)
//
// Thin HTTP wrapper around _shared/store-place-images.ts. Kept as a separate EF
// so image mirroring runs in its own wall clock (invoked by contents S9).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import {
  type PlaceImageAssetInput,
  storePlaceImages,
} from "../_shared/store-place-images.ts";

type Body = {
  project_id?: string;
  assets?: PlaceImageAssetInput[];
  preferred_photo_urls?: string[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const projectId = typeof bodyRes.body.project_id === "string" ? bodyRes.body.project_id.trim() : "";
  if (!projectId) return json({ ok: false, error: "project_id is required" }, 400);

  const admin = adminClient(envRes.env);
  const result = await storePlaceImages(
    admin,
    envRes.env.url,
    projectId,
    bodyRes.body.assets ?? [],
    bodyRes.body.preferred_photo_urls ?? [],
  );
  if (!result.ok) return json({ ok: false, error: result.error }, 500);

  return json({
    ok: true,
    queued: result.queued,
    preferred: result.preferred,
    caller: callerRes.callerName,
  });
});
