// Supabase Edge Function — twilio-whatsapp-inbound (external caller)
//
// Public webhook (verify_jwt = false). Routes inbound WhatsApp to:
//   • Mesita Ops (Staff) — Type A discount billing via LLM + session state
//   • Mesita Consumers — acknowledgement (support flows later)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  emptyMessagingTwiml,
  normaliseWhatsAppFrom,
  parseTwilioForm,
  readTwilioEnv,
  sendWhatsAppText,
  validateTwilioRequest,
  webhookUrlForFunction,
} from "../_shared/twilio.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import {
  handleStaffInboundMessage,
  resolveStaffAccess,
} from "../_shared/staff-whatsapp-flow.ts";
import {
  isWhatsAppFlowSubmission,
  promptPendingStaffInviteOnWhatsApp,
  tryAcceptStaffInviteFromFlow,
  tryAcceptStaffInviteOnWhatsApp,
} from "../_shared/staff-invite-whatsapp.ts";
import { replyUnauthorizedStaff } from "../_shared/staff-whatsapp-replies.ts";

function phoneFromWhatsAppAddress(addr: string): string {
  const raw = addr.replace(/^whatsapp:/i, "").trim();
  return raw.startsWith("+") ? raw : `+${raw}`;
}

function isStaffLine(to: string, staffFrom: string): boolean {
  const a = normaliseWhatsAppFrom(to);
  const b = normaliseWhatsAppFrom(staffFrom);
  return a === b;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const twilio = readTwilioEnv();
  if (!twilio.ok) {
    console.error("[twilio-whatsapp-inbound]", twilio.error);
    return new Response("Twilio not configured", { status: 500 });
  }

  const params = await parseTwilioForm(req);
  const url = webhookUrlForFunction("twilio-whatsapp-inbound");
  const valid = await validateTwilioRequest(
    twilio.env.authToken,
    req.headers.get("X-Twilio-Signature"),
    url,
    params,
  );
  if (!valid) {
    console.warn("[twilio-whatsapp-inbound] invalid signature", { url });
    return new Response("Forbidden", { status: 403 });
  }

  const body = (params.Body ?? "").trim();
  const fromPhone = phoneFromWhatsAppAddress(params.From ?? "");
  const toLine = params.To ?? "";
  const flowSubmission = isWhatsAppFlowSubmission(params);

  console.info("[twilio-whatsapp-inbound]", {
    messageSid: params.MessageSid,
    from: fromPhone,
    to: toLine,
    body: body.slice(0, 200),
    flowSubmission,
    messageType: params.MessageType,
  });

  const envRes = readEFEnv();
  if (!envRes.ok) {
    console.error("[twilio-whatsapp-inbound] supabase env", envRes.error);
    return emptyMessagingTwiml();
  }
  const admin = adminClient(envRes.env);

  try {
    if (isStaffLine(toLine, twilio.env.whatsappFromStaff)) {
      if (flowSubmission) {
        const fromFlow = await tryAcceptStaffInviteFromFlow({
          admin,
          twilio: twilio.env,
          fromPhone,
          params,
        });
        if (fromFlow.handled) return emptyMessagingTwiml();
      }

      if (!body && !flowSubmission) {
        await sendWhatsAppText({
          env: twilio.env,
          from: twilio.env.whatsappFromStaff,
          to: fromPhone,
          body:
            "Mesita Ops here — send a guest code (0000-0000), pick your unit, or type HELP.",
        }).catch(() => {});
        return emptyMessagingTwiml();
      }

      const accepted = await tryAcceptStaffInviteOnWhatsApp({
        admin,
        twilio: twilio.env,
        fromPhone,
        body,
      });
      if (accepted.handled) {
        return emptyMessagingTwiml();
      }

      const access = await resolveStaffAccess(admin, fromPhone);
      if (access.status !== "ok") {
        const prompted = await promptPendingStaffInviteOnWhatsApp({
          admin,
          twilio: twilio.env,
          fromPhone,
          body,
        });
        if (!prompted.handled) {
          const msg = await replyUnauthorizedStaff(access.status, body);
          await sendWhatsAppText({
            env: twilio.env,
            from: twilio.env.whatsappFromStaff,
            to: fromPhone,
            body: msg,
          });
        }
      } else {
        await handleStaffInboundMessage({
          admin,
          twilio: twilio.env,
          identity: access.identity,
          body,
        });
      }
    } else {
      await sendWhatsAppText({
        env: twilio.env,
        from: twilio.env.whatsappFromConsumers,
        to: fromPhone,
        body:
          "Thanks for messaging Mesita. For dining rewards, use the Mesita app. This line is for account support coming soon.",
      });
    }
  } catch (err) {
    console.error("[twilio-whatsapp-inbound] handler error", err);
    if (isStaffLine(toLine, twilio.env.whatsappFromStaff)) {
      await sendWhatsAppText({
        env: twilio.env,
        from: twilio.env.whatsappFromStaff,
        to: fromPhone,
        body: "Something went wrong on our side. Please try again in a moment.",
      }).catch(() => {});
    }
  }

  return emptyMessagingTwiml();
});
