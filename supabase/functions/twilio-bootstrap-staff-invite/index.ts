// One-shot (admin): create staff-invite twilio/text Content template (prod Twilio secrets).

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
        "Hola — {{1}} te invita a usar Mesita Ops por WhatsApp para tickets con descuento.\n\nSi quieres unirte al equipo, responde sí a este mensaje.",
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  const twilio = readTwilioEnv();
  if (!twilio.ok) return json({ ok: false, error: twilio.error }, 500);

  const auth = btoa(`${twilio.env.accountSid}:${twilio.env.authToken}`);

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
    templateType: "twilio/text",
    whatsappApproval: (approval as { status?: string }).status ?? "submitted",
    note: "Natural-language invite; waiter replies sí. Add twilio/flows later if needed.",
  });
});
