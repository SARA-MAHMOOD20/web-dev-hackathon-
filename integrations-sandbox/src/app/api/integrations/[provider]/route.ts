import { NextResponse } from "next/server";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { PROVIDERS, removeConnection, saveConnection, type Provider } from "@/server/integrations/connections";
import { UserError } from "@/server/integrations/errors";

type Ctx = { params: Promise<{ provider: string }> };

async function provider(params: Ctx["params"]): Promise<Provider> {
  const { provider } = await params;
  if (!PROVIDERS.includes(provider as Provider)) throw new UserError("Unknown integration.", 404);
  return provider as Provider;
}

// I5.7: only users with the integration permission; every change is audited inside saveConnection.
export const PUT = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser("integrations.manage");
  await saveConnection(user.workspaceId, await provider(params), await req.json(), user.id);
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser("integrations.manage");
  await removeConnection(user.workspaceId, await provider(params), user.id);
  return NextResponse.json({ ok: true });
});
