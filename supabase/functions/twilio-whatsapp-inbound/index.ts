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
import {
  appendStaffWhatsAppMessage,
  loadStaffWhatsAppHistoryText,
  sendStaffWhatsAppReply,
} from "../_shared/staff-whatsapp-messages.ts";

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
  const staffLine = isStaffLine(toLine, twilio.env.whatsappFromStaff);

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
    console.error("[twilio-whatsapp-inbound] supabase env missing");
    return emptyMessagingTwiml();
  }
  const admin = adminClient(envRes.env);

  let conversationHistory = "";

  try {
    if (staffLine) {
      if (body) {
        conversationHistory = await loadStaffWhatsAppHistoryText(
          admin,
          fromPhone,
        );
        await appendStaffWhatsAppMessage(admin, {
          phoneE164: fromPhone,
          direction: "inbound",
          body,
          twilioMessageSid: params.MessageSid,
        });
      } else if (flowSubmission) {
        conversationHistory = await loadStaffWhatsAppHistoryText(
          admin,
          fromPhone,
        );
        await appendStaffWhatsAppMessage(admin, {
          phoneE164: fromPhone,
          direction: "inbound",
          body: "[formulario WhatsApp]",
          twilioMessageSid: params.MessageSid,
        });
      }

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
        await sendStaffWhatsAppReply(
          admin,
          twilio.env,
          fromPhone,
          "Hola, soy Mesita Ops. Manda el código del comensal (0000-0000), elige tu unidad o escribe ayuda.",
        ).catch(() => {});
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
          const msg = await replyUnauthorizedStaff(
            access.status,
            body,
            conversationHistory,
          );
          await sendStaffWhatsAppReply(
            admin,
            twilio.env,
            fromPhone,
            msg,
          );
        }
      } else {
        await handleStaffInboundMessage({
          admin,
          twilio: twilio.env,
          identity: access.identity,
          body,
          conversationHistory,
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
    if (staffLine) {
      await sendStaffWhatsAppReply(
        admin,
        twilio.env,
        fromPhone,
        "Algo falló de nuestro lado. Intenta de nuevo en un momento.",
      ).catch(() => {});
    }
  }

  return emptyMessagingTwiml();
});
