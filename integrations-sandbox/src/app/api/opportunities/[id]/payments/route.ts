import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { createPaymentLink } from "@/server/integrations/stripe";

const Body = z.object({
  amount: z.number().int().min(50, "Minimum is 50 (= 0.50 in the currency)"), // smallest unit: 5000 = 50.00
  currency: z.string().length(3).toLowerCase().default("usd"),
});

export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser("crm.edit");
  const { amount, currency } = Body.parse(await req.json());
  const payment = await createPaymentLink({ workspaceId: user.workspaceId, opportunityId: (await params).id, userId: user.id, amount, currency });
  return NextResponse.json({ payment });
});
