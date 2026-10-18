import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { bookAppointment } from "@/server/integrations/google";

const Body = z.object({
  userId: z.string(),
  contactId: z.string(),
  opportunityId: z.string().nullish(),
  title: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }), // e.g. 2026-10-18T15:00:00+05:00 or ...Z
  endsAt: z.iso.datetime({ offset: true }),
  force: z.boolean().optional(), // book even though the slot overlaps
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser("crm.edit");
  const b = Body.parse(await req.json());
  const appointment = await bookAppointment({
    ...b, workspaceId: user.workspaceId, actorId: user.id, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt),
  });
  return NextResponse.json({ appointment });
});
