// SANDBOX ONLY: pretends the escalation engine just escalated a lead to you.
import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { notifyEscalation } from "@/server/integrations/email";

export const POST = handle(async () => {
  const user = await requireUser();
  const lead = await db.lead.findFirstOrThrow({ where: { workspaceId: user.workspaceId }, orderBy: { createdAt: "desc" } });
  const notification = await notifyEscalation({ workspaceId: user.workspaceId, userId: user.id, leadId: lead.id, reason: "Not acknowledged within 30 seconds" });
  return NextResponse.json({ notification });
});
