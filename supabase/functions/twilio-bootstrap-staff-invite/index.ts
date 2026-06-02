// One-shot (admin): create staff-invite twilio/flows Content template (prod Twilio secrets).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { readTwilioEnv } from "../_shared/twilio.ts";

const CONTENT_API = "https://content.twilio.com/v1/Content";

const FLOW_TEMPLATE = {
  friendly_name: "staff-invite",
  language: "es",
  types: {
    "twilio/flows": {
      body: "{{1}} te invita a Mesita Ops.",
      button_text: "Unirme",
      type: "SIGN_UP",
      pages: [
        {
          id: "join_team",
          next_page_id: null,
          title: "Unirte al equipo",
          layout: [
            {
              type: "TEXT_BODY",
              text: "Confirma para unirte como mesero/a. Todo pasa en este chat.",
            },
            {
              type: "FOOTER",
              label: "Confirmar",
            },
          ],
        },
      ],
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
    body: JSON.stringify(FLOW_TEMPLATE),
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
    templateType: "twilio/flows",
    whatsappApproval: (approval as { status?: string }).status ?? "submitted",
    note: "Meta publishes the Flow when WhatsApp approves this template.",
  });
});
