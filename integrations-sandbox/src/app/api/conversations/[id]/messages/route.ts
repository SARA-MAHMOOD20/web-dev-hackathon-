import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { UserError } from "@/server/integrations/errors";
import { sendReply } from "@/server/integrations/whatsapp";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser("crm.view");
  const { id } = await params;
  const convo = await db.conversation.findFirst({ where: { id, workspaceId: user.workspaceId } });
  if (!convo) throw new UserError("Conversation not found.", 404);
  const messages = await db.message.findMany({ where: { conversationId: id, workspaceId: user.workspaceId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ conversation: convo, messages });
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser("crm.edit");
  const { id } = await params;
  const { body } = z.object({ body: z.string().trim().min(1).max(4096) }).parse(await req.json());
  const message = await sendReply(user.workspaceId, id, body, user.id);
  return NextResponse.json({ message }, { status: message.status === "failed" ? 502 : 200 });
});
