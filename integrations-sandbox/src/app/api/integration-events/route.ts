import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";

// I5.4: synchronization history, filterable by provider and result.
export const GET = handle(async (req: Request) => {
  const user = await requireUser("integrations.manage");
  const q = new URL(req.url).searchParams;
  const events = await db.integrationEvent.findMany({
    where: {
      workspaceId: user.workspaceId,
      ...(q.get("provider") ? { provider: q.get("provider")! } : {}),
      ...(q.get("result") ? { result: q.get("result")! } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ events });
});
