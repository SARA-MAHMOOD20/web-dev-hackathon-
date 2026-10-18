import { NextResponse } from "next/server";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { disconnect } from "@/server/integrations/google";

export const DELETE = handle(async () => {
  await disconnect(await requireUser());
  return NextResponse.json({ ok: true });
});
