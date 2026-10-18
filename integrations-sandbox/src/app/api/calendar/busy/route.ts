import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { busyTimes } from "@/server/integrations/google";

const Query = z.object({ userId: z.string(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) });

export const GET = handle(async (req: Request) => {
  const user = await requireUser("crm.view");
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return NextResponse.json({ busy: await busyTimes(user.workspaceId, q.userId, new Date(q.from), new Date(q.to)) });
});
