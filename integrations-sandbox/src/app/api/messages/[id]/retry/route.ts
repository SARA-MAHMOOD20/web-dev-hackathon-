import { NextResponse } from "next/server";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { deliver } from "@/server/integrations/whatsapp";

export const POST = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("crm.edit");
  const message = await deliver(user.workspaceId, (await params).id);
  return NextResponse.json({ message }, { status: message.status === "failed" ? 502 : 200 });
});
