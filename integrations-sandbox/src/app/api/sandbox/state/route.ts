// SANDBOX ONLY (not copied at merge): everything the test page shows, in one call.
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { collectedRevenue } from "@/server/integrations/stripe";

export const GET = handle(async () => {
  const { workspaceId } = await requireUser();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [contacts, conversations, messages, opportunities, payments, appointments, notifications, leads, activity, users, collected] = await Promise.all([
    db.contact.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
    db.conversation.findMany({ where: { workspaceId }, orderBy: { lastMessageAt: "desc" } }),
    db.message.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    db.opportunity.findMany({ where: { workspaceId } }),
    db.payment.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
    db.appointment.findMany({ where: { workspaceId }, orderBy: { startsAt: "asc" } }),
    db.notification.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.lead.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
    db.activity.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 15 }),
    db.user.findMany({ where: { workspaceId } }),
    collectedRevenue(workspaceId, monthStart),
  ]);
  return NextResponse.json({ contacts, conversations, messages, opportunities, payments, appointments, notifications, leads, activity, users, collected });
});
