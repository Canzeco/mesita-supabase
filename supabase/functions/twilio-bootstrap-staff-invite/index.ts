// One-shot (admin): create staff-invite Content template using prod Twilio secrets.
// Invoke: supabase functions invoke twilio-bootstrap-staff-invite --project-ref yjalywfzdelacdzccpgb

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { readTwilioEnv } from "../_shared/twilio.ts";

const CONTENT_API = "https://content.twilio.com/v1/Content";

const TEXT_TEMPLATE = {
  friendly_name: "staff-invite",
  language: "es",
  types: {
    "twilio/text": {
      body:
        "Mesita · {{1}} te invita como mesero/a. Toca «Unirme» si ves el botón, o responde SI en este chat. Todo aquí, sin links.",
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  const bootstrapKey = Deno.env.get("TWILIO_BOOTSTRAP_KEY")?.trim();
  const provided = req.headers.get("X-Bootstrap-Key")?.trim();
  if (bootstrapKey && provided !== bootstrapKey) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const twilio = readTwilioEnv();
  if (!twilio.ok) return json({ ok: false, error: twilio.error }, 500);

  const auth = btoa(`${twilio.env.accountSid}:${twilio.env.authToken}`);

  const listRes = await fetch(`${CONTENT_API}?PageSize=100`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!listRes.ok) {
    const err = await listRes.text();
    return json({ ok: false, error: `list: ${err}` }, 500);
  }
  const list = (await listRes.json()) as {
    contents?: { friendly_name?: string; sid?: string }[];
  };
  const existing = (list.contents ?? []).find(
    (c) => c.friendly_name === "staff-invite",
  );
  if (existing?.sid) {
    return json({
      ok: true,
      contentSid: existing.sid,
      created: false,
      note: "Template staff-invite already exists",
    });
  }

  const createRes = await fetch(CONTENT_API, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(TEXT_TEMPLATE),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    return json(
      {
        ok: false,
        error: (created as { message?: string }).message ?? createRes.statusText,
      },
      500,
    );
  }
  const sid = (created as { sid?: string }).sid;
  if (!sid) return json({ ok: false, error: "no sid in response" }, 500);

  const approvalRes = await fetch(
    `${CONTENT_API}/${sid}/ApprovalRequests/whatsapp`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "staff-invite", category: "UTILITY" }),
    },
  );
  const approval = await approvalRes.json().catch(() => ({}));

  return json({
    ok: true,
    contentSid: sid,
    created: true,
    whatsappApproval: (approval as { status?: string }).status ?? "submitted",
    setSecret: `supabase secrets set TWILIO_CONTENT_SID_STAFF_INVITE=${sid}`,
  });
});
