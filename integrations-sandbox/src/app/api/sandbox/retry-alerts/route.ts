// SANDBOX ONLY: in the real app the escalation sweep calls retryFailedNotifications.
import { NextResponse } from "next/server";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { retryFailedNotifications } from "@/server/integrations/email";

export const POST = handle(async () => {
  await retryFailedNotifications((await requireUser()).workspaceId);
  return NextResponse.json({ ok: true });
});
