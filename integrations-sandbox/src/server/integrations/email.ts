// Escalation alerts by email via Resend (I4).
import { Resend } from "resend";
import { db } from "@/server/db";
import { findConnection, logEvent, markError, markSuccess } from "./connections";

const MAX_ATTEMPTS = 3;

/** Called by the escalation engine when a lead moves to a new owner (I4.1). */
export async function notifyEscalation(input: { workspaceId: string; userId: string; leadId: string; reason: string }) {
  const user = await db.user.findFirstOrThrow({ where: { id: input.userId, workspaceId: input.workspaceId } });
  const note = await db.notification.create({
    data: { ...input, to: user.alertEmail ?? user.email, status: "pending" }, // I4.3: per-user destination
  });
  return attempt(note.id);
}

/** I4.4: call from the escalation sweep. Retries failed alerts up to MAX_ATTEMPTS in total. */
export async function retryFailedNotifications(workspaceId: string) {
  const failed = await db.notification.findMany({ where: { workspaceId, status: "failed", attempts: { lt: MAX_ATTEMPTS } }, take: 20 });
  for (const n of failed) await attempt(n.id);
}

async function attempt(notificationId: string) {
  const note = await db.notification.findUniqueOrThrow({ where: { id: notificationId } });
  const lead = await db.lead.findFirstOrThrow({ where: { id: note.leadId, workspaceId: note.workspaceId } });
  const contact = await db.contact.findFirstOrThrow({ where: { id: lead.contactId, workspaceId: note.workspaceId } });
  const conn = await findConnection(note.workspaceId, "email");

  let error: string | null = conn ? null : "Email is not connected for this workspace.";
  let providerId: string | null = null;
  if (conn) {
    const link = `${process.env.APP_URL}/leads/${lead.id}`;
    try {
      const { data, error: sendError } = await new Resend(conn.secrets.apiKey).emails.send({
        from: conn.secrets.from,
        to: note.to,
        subject: `Lead escalated to you: ${contact.name}`,
        text: `Lead: ${contact.name}\nSource: ${lead.source}\nReason: ${note.reason}\nOpen it: ${link}`,
        html: `<p>A lead was escalated to you.</p>
<p><b>Lead:</b> ${esc(contact.name)}<br><b>Source:</b> ${esc(lead.source)}<br><b>Reason:</b> ${esc(note.reason)}</p>
<p><a href="${esc(link)}">Open the lead</a></p>`,
      });
      if (sendError) error = `Email provider rejected the alert: ${sendError.message}`;
      else providerId = data?.id ?? null;
    } catch {
      error = "Could not reach the email provider.";
    }
  }

  const attempts = note.attempts + 1;
  const updated = await db.notification.update({
    where: { id: note.id },
    data: error
      ? { attempts, lastError: error, status: attempts >= MAX_ATTEMPTS ? "gave_up" : "failed" }
      : { attempts, lastError: null, status: "sent", providerId },
  });
  if (error) {
    if (conn) await markError(note.workspaceId, "email", error, attempts >= MAX_ATTEMPTS);
  } else {
    await markSuccess(note.workspaceId, "email");
  }
  await logEvent({
    workspaceId: note.workspaceId, provider: "email", direction: "out", type: "escalation.alert",
    result: error ? "error" : "ok", reference: providerId, error,
  });
  return updated;
}

/** Customer names come from outside (WhatsApp profile, web form), so escape them (Q3). */
function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
