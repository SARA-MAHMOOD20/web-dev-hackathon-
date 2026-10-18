import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { changeAppointment } from "@/server/integrations/google";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) });

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser("crm.edit");
  const b = Body.parse(await req.json());
  const appointment = await changeAppointment({
    workspaceId: user.workspaceId, actorId: user.id, appointmentId: (await params).id, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt),
  });
  return NextResponse.json({ appointment });
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser("crm.edit");
  const appointment = await changeAppointment({ workspaceId: user.workspaceId, actorId: user.id, appointmentId: (await params).id, cancel: true });
  return NextResponse.json({ appointment });
});
