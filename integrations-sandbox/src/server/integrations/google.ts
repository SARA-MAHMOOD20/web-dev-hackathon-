// Google Calendar through OAuth 2.0 (I3). Each employee connects their own calendar.
import { google, type calendar_v3 } from "googleapis";
import { db } from "@/server/db";
import { audit, logActivity, recordLeadAction } from "@/server/adapters";
import { logEvent } from "./connections";
import { decrypt, encrypt } from "./crypto";
import { UserError } from "./errors";

const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

const oauthClient = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI ?? `${process.env.APP_URL}/api/integrations/google/callback`,
);

/** I3.1: where to send the employee. `state` must also be saved in a cookie and compared on return. */
export function consentUrl(state: string) {
  return oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
}

export async function finishConnect(user: { id: string; workspaceId: string }, code: string) {
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.access_token) throw new UserError("Google did not return an access token. Try connecting again.");
  const googleEmail = tokens.id_token
    ? (JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()).email as string)
    : null;
  const existing = await db.googleAccount.findUnique({ where: { userId: user.id } });
  if (!tokens.refresh_token && !existing) throw new UserError("Google did not return a refresh token. Remove the app's access in your Google account and connect again.");

  const data = {
    workspaceId: user.workspaceId, googleEmail,
    accessToken: encrypt(tokens.access_token),
    refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : existing!.refreshToken,
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3500_000),
    status: "connected", lastError: null,
  };
  await db.googleAccount.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
  await audit({ workspaceId: user.workspaceId, actorId: user.id, action: "integration.connected", targetType: "google_calendar", targetId: user.id, after: { googleEmail } });
  await logEvent({ workspaceId: user.workspaceId, provider: "google", direction: "out", type: "oauth.connect", result: "ok", reference: googleEmail });
}

export async function disconnect(user: { id: string; workspaceId: string }) {
  const acc = await db.googleAccount.findUnique({ where: { userId: user.id } });
  if (!acc) return;
  try { await oauthClient().revokeToken(decrypt(acc.refreshToken)); } catch { /* already revoked: fine */ }
  await db.googleAccount.delete({ where: { userId: user.id } });
  await audit({ workspaceId: user.workspaceId, actorId: user.id, action: "integration.removed", targetType: "google_calendar", targetId: user.id, before: { googleEmail: acc.googleEmail } });
}

/** I3.2: a client that refreshes its own access token and saves the new one. */
async function calendarFor(workspaceId: string, userId: string) {
  const user = await db.user.findFirst({ where: { id: userId, workspaceId } });
  if (!user) throw new UserError("Employee not found.", 404);
  const acc = await db.googleAccount.findUnique({ where: { userId } });
  // I3.7: an employee without a connected calendar cannot be booked, and we say why.
  if (!acc) throw new UserError(`${user.name} hasn't connected a Google Calendar, so they can't be booked yet.`, 409);
  if (acc.status !== "connected") throw new UserError(`${user.name}'s Google Calendar connection expired. They need to reconnect it on the Integrations page.`, 409);

  const auth = oauthClient();
  auth.setCredentials({ access_token: decrypt(acc.accessToken), refresh_token: decrypt(acc.refreshToken), expiry_date: acc.expiresAt.getTime() });
  auth.on("tokens", async (t) => {
    if (t.access_token) {
      await db.googleAccount.update({
        where: { userId },
        data: { accessToken: encrypt(t.access_token), expiresAt: new Date(t.expiry_date ?? Date.now() + 3500_000) },
      });
    }
  });
  return { cal: google.calendar({ version: "v3", auth }), user };
}

/** Runs a Google call; a revoked/expired grant flips the account to needs_reconnect. */
async function call<T>(workspaceId: string, userId: string, type: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await logEvent({ workspaceId, provider: "google", direction: "out", type, result: "ok" });
    return result;
  } catch (e) {
    const err = e as { message?: string; response?: { status?: number; data?: { error?: string } } };
    const authFailed = err.response?.data?.error === "invalid_grant" || err.response?.status === 401 || /invalid_grant/.test(err.message ?? "");
    await logEvent({ workspaceId, provider: "google", direction: "out", type, result: "error", error: err.message ?? "unknown" });
    if (authFailed) {
      await db.googleAccount.update({ where: { userId }, data: { status: "needs_reconnect", lastError: err.message ?? "invalid_grant" } });
      throw new UserError("The Google Calendar connection was revoked or expired. Reconnect it on the Integrations page.", 409);
    }
    throw new UserError(`Google Calendar error: ${err.message ?? "unknown"}. Try again.`, 502);
  }
}

/** I3.4: the employee's busy blocks between two instants. */
export async function busyTimes(workspaceId: string, userId: string, from: Date, to: Date) {
  const { cal } = await calendarFor(workspaceId, userId);
  const res = await call(workspaceId, userId, "freebusy.query", () =>
    cal.freebusy.query({ requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] } }));
  return (res.data.calendars?.primary?.busy ?? []).map((b) => ({ start: b.start!, end: b.end! }));
}

/** I3.3, I3.5: book on the employee's real calendar. Stored in UTC + the employee's zone. */
export async function bookAppointment(input: {
  workspaceId: string; actorId: string; userId: string; contactId: string; opportunityId?: string | null;
  title: string; startsAt: Date; endsAt: Date; force?: boolean;
}) {
  const { workspaceId } = input;
  if (input.endsAt <= input.startsAt) throw new UserError("The end time must be after the start time.");
  const contact = await db.contact.findFirst({ where: { id: input.contactId, workspaceId } });
  if (!contact) throw new UserError("Contact not found.", 404);
  const { cal, user } = await calendarFor(workspaceId, input.userId);

  const clashes = await busyTimes(workspaceId, input.userId, input.startsAt, input.endsAt);
  if (clashes.length && !input.force) {
    throw new UserError(`${user.name} is busy during that time. Pick another slot or book anyway.`, 409, { clashes });
  }

  const ev = await call(workspaceId, input.userId, "events.insert", () =>
    cal.events.insert({ calendarId: "primary", requestBody: eventBody(input.title, contact, input.startsAt, input.endsAt, user.timeZone) }));
  const appt = await db.appointment.create({
    data: {
      workspaceId, contactId: contact.id, opportunityId: input.opportunityId ?? null, userId: input.userId,
      title: input.title, googleEventId: ev.data.id ?? null, startsAt: input.startsAt, endsAt: input.endsAt, timeZone: user.timeZone,
    },
  });
  await logActivity({ workspaceId, contactId: contact.id, opportunityId: appt.opportunityId, type: "appointment.booked", actorId: input.actorId, data: { title: appt.title, startsAt: appt.startsAt, with: user.name } });
  await recordLeadAction({ workspaceId, contactId: contact.id, userId: input.actorId, kind: "appointment" });
  return appt;
}

/** I3.6: reschedule or cancel; both update the Google event and the timeline. */
export async function changeAppointment(input: {
  workspaceId: string; actorId: string; appointmentId: string; startsAt?: Date; endsAt?: Date; cancel?: boolean;
}) {
  const appt = await db.appointment.findFirst({ where: { id: input.appointmentId, workspaceId: input.workspaceId } });
  if (!appt) throw new UserError("Appointment not found.", 404);
  if (appt.status === "cancelled") throw new UserError("This appointment is already cancelled.");
  const { cal } = await calendarFor(input.workspaceId, appt.userId);

  if (input.cancel) {
    if (appt.googleEventId) {
      await call(input.workspaceId, appt.userId, "events.delete", () => cal.events.delete({ calendarId: "primary", eventId: appt.googleEventId! }));
    }
    const updated = await db.appointment.update({ where: { id: appt.id }, data: { status: "cancelled" } });
    await logActivity({ workspaceId: appt.workspaceId, contactId: appt.contactId, opportunityId: appt.opportunityId, type: "appointment.cancelled", actorId: input.actorId, data: { title: appt.title } });
    return updated;
  }

  const startsAt = input.startsAt ?? appt.startsAt;
  const endsAt = input.endsAt ?? appt.endsAt;
  if (endsAt <= startsAt) throw new UserError("The end time must be after the start time.");
  if (appt.googleEventId) {
    await call(input.workspaceId, appt.userId, "events.patch", () => cal.events.patch({
      calendarId: "primary", eventId: appt.googleEventId!,
      requestBody: { start: { dateTime: startsAt.toISOString(), timeZone: appt.timeZone }, end: { dateTime: endsAt.toISOString(), timeZone: appt.timeZone } },
    }));
  }
  const updated = await db.appointment.update({ where: { id: appt.id }, data: { startsAt, endsAt } });
  await logActivity({ workspaceId: appt.workspaceId, contactId: appt.contactId, opportunityId: appt.opportunityId, type: "appointment.rescheduled", actorId: input.actorId, data: { from: appt.startsAt, to: startsAt } });
  return updated;
}

function eventBody(title: string, contact: { name: string; phone: string | null; email: string | null }, start: Date, end: Date, timeZone: string): calendar_v3.Schema$Event {
  return {
    summary: title,
    description: `Customer: ${contact.name}${contact.phone ? `\nPhone: +${contact.phone}` : ""}${contact.email ? `\nEmail: ${contact.email}` : ""}\nBooked from LeadGuard`,
    start: { dateTime: start.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
  };
}
