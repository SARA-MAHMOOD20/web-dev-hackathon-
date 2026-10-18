// WhatsApp via Meta's WhatsApp Cloud API (replaces the Twilio sandbox; same role: I1).
import crypto from "node:crypto";
import { db } from "@/server/db";
import { createLead, logActivity, recordLeadAction } from "@/server/adapters";
import { getConnection, logEvent, markError, markSuccess } from "./connections";
import { safeEqual } from "./crypto";
import { ProviderError, UserError, isRetryableStatus, withRetry } from "./errors";

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION ?? "v24.0"}`;

// ─── Inbound ───────────────────────────────────────────────────────────────

/** I1.2: Meta signs the raw body with the App Secret (HMAC-SHA256). */
export function verifySignature(rawBody: string, header: string | null, appSecret: string) {
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return !!header && safeEqual(header, expected);
}

type MetaMessage = { from: string; id: string; type: string; text?: { body: string } };
type MetaStatus = { id: string; status: string; errors?: { code: number; title: string; message?: string }[] };
type MetaPayload = {
  entry?: { changes?: { value: { contacts?: { profile?: { name?: string } }[]; messages?: MetaMessage[]; statuses?: MetaStatus[] } }[] }[];
};

export async function handlePayload(workspaceId: string, payload: MetaPayload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      for (const m of v.messages ?? []) await handleIncoming(workspaceId, m, v.contacts?.[0]?.profile?.name);
      for (const s of v.statuses ?? []) await handleStatus(workspaceId, s);
    }
  }
}

/** I1.1, I1.5, I1.8: attach to a known contact, or create contact + lead. Duplicates are ignored. */
async function handleIncoming(workspaceId: string, m: MetaMessage, profileName?: string) {
  const body = m.text?.body ?? `[${m.type} message]`;
  try {
    await db.$transaction(async (tx) => {
      let contact = await tx.contact.findFirst({ where: { workspaceId, phone: m.from } });
      const isNew = !contact;
      contact ??= await tx.contact.create({ data: { workspaceId, phone: m.from, name: profileName ?? `+${m.from}` } });

      const lead = isNew ? await createLead({ workspaceId, contactId: contact.id, source: "whatsapp" }, tx) : null;
      const convo = await tx.conversation.upsert({
        where: { workspaceId_contactId_channel: { workspaceId, contactId: contact.id, channel: "whatsapp" } },
        create: { workspaceId, contactId: contact.id, channel: "whatsapp", assignedUserId: lead?.ownerId ?? null },
        update: { lastMessageAt: new Date() },
      });
      // Unique providerId: a second delivery of the same message fails here, and the
      // whole transaction (contact, lead, conversation) rolls back with it.
      await tx.message.create({
        data: { workspaceId, conversationId: convo.id, direction: "in", body, status: "received", providerId: m.id },
      });

      // I1.9: a customer can opt out by replying STOP.
      if (body.trim().toUpperCase() === "STOP") await tx.contact.update({ where: { id: contact.id }, data: { optedOut: true } });

      await logActivity({ workspaceId, contactId: contact.id, type: "message.received", data: { body, channel: "whatsapp" } }, tx);
    });
    await logEvent({ workspaceId, provider: "whatsapp", direction: "in", type: "message.received", result: "ok", reference: m.id });
    await markSuccess(workspaceId, "whatsapp");
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      await logEvent({ workspaceId, provider: "whatsapp", direction: "in", type: "message.received", result: "duplicate", reference: m.id });
      return;
    }
    throw e;
  }
}

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/** I1.4: sent → delivered → read, or failed with the reason. Never moves backwards. */
async function handleStatus(workspaceId: string, s: MetaStatus) {
  const msg = await db.message.findFirst({ where: { workspaceId, providerId: s.id } });
  if (!msg) {
    await logEvent({ workspaceId, provider: "whatsapp", direction: "in", type: `status.${s.status}`, result: "ignored", reference: s.id });
    return;
  }
  if ((RANK[s.status] ?? 0) > (RANK[msg.status] ?? 0)) {
    const err = s.errors?.[0];
    await db.message.update({
      where: { id: msg.id },
      data: { status: s.status, error: err ? explainMetaError(err.code, err.message ?? err.title) : null },
    });
  }
  await logEvent({ workspaceId, provider: "whatsapp", direction: "in", type: `status.${s.status}`, result: "ok", reference: s.id });
}

// ─── Outbound ──────────────────────────────────────────────────────────────

/** I1.3: queue the reply, then deliver it. The message exists even if sending fails (I1.7). */
export async function sendReply(workspaceId: string, conversationId: string, body: string, userId: string) {
  const convo = await db.conversation.findFirst({ where: { id: conversationId, workspaceId } });
  if (!convo) throw new UserError("Conversation not found.", 404);
  const contact = await db.contact.findFirstOrThrow({ where: { id: convo.contactId, workspaceId } });
  assertCanMessage(contact);
  const msg = await db.message.create({
    data: { workspaceId, conversationId, direction: "out", body, status: "queued", sentById: userId },
  });
  return deliver(workspaceId, msg.id);
}

/** Sends a queued or failed message. Also used by the Retry button. */
export async function deliver(workspaceId: string, messageId: string) {
  const msg = await db.message.findFirst({ where: { id: messageId, workspaceId, direction: "out" } });
  if (!msg) throw new UserError("Message not found.", 404);
  if (msg.status !== "queued" && msg.status !== "failed") throw new UserError("Only queued or failed messages can be sent again.");
  const convo = await db.conversation.findFirstOrThrow({ where: { id: msg.conversationId, workspaceId } });
  const contact = await db.contact.findFirstOrThrow({ where: { id: convo.contactId, workspaceId } });
  assertCanMessage(contact);

  try {
    const { secrets } = await getConnection(workspaceId, "whatsapp");
    const wamid = await withRetry(() => callSend(secrets.phoneNumberId, secrets.accessToken, contact.phone!, msg.body));
    await db.message.update({ where: { id: msg.id }, data: { status: "sent", providerId: wamid, error: null } });
    await markSuccess(workspaceId, "whatsapp");
    await logEvent({ workspaceId, provider: "whatsapp", direction: "out", type: "message.send", result: "ok", reference: wamid });
    await logActivity({ workspaceId, contactId: contact.id, type: "message.sent", actorId: msg.sentById, data: { body: msg.body } });
    if (msg.sentById) await recordLeadAction({ workspaceId, contactId: contact.id, userId: msg.sentById, kind: "message" });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Unknown error";
    await db.message.update({ where: { id: msg.id }, data: { status: "failed", error: reason } });
    if (e instanceof ProviderError) await markError(workspaceId, "whatsapp", reason, !e.retryable);
    await logEvent({ workspaceId, provider: "whatsapp", direction: "out", type: "message.send", result: "error", error: reason });
  }
  return db.message.findUniqueOrThrow({ where: { id: msg.id } });
}

function assertCanMessage(contact: { name: string; phone: string | null; optedOut: boolean }) {
  if (contact.optedOut) throw new UserError(`${contact.name} opted out of WhatsApp messages, so the platform will not message them.`, 409);
  if (!contact.phone) throw new UserError(`${contact.name} has no phone number.`, 409);
}

async function callSend(phoneNumberId: string, token: string, to: string, body: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ProviderError("Could not reach WhatsApp. It will be retried; you can also press Retry.", true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ProviderError(explainMetaError(data?.error?.code, data?.error?.message ?? `HTTP ${res.status}`), isRetryableStatus(res.status), res.status);
  }
  return data.messages[0].id as string;
}

/** I5.5: plain explanations for the errors you will actually hit. */
function explainMetaError(code: number | undefined, fallback: string) {
  switch (code) {
    case 131047: return "More than 24 hours since the customer's last message. WhatsApp only allows template messages now.";
    case 131030: return "This number isn't on the test number's allowed list. Add it in the Meta dashboard (WhatsApp → API Setup → To).";
    case 131026: return "This number can't receive WhatsApp messages.";
    case 190: return "The WhatsApp access token expired or is invalid. Update it on the Integrations page.";
    case 130429: case 131056: return "WhatsApp rate limit reached. Try again in a minute.";
    default: return `WhatsApp error${code ? ` ${code}` : ""}: ${fallback}`;
  }
}
