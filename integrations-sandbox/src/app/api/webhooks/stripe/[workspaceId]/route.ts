import { handleWebhook } from "@/server/integrations/stripe";

export async function POST(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const raw = await req.text(); // never req.json(): Stripe signs the raw bytes
  const { status, body } = await handleWebhook(workspaceId, raw, req.headers.get("stripe-signature"));
  return Response.json(body, { status });
}
