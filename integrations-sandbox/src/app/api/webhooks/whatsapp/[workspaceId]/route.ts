import { findConnection, logEvent } from "@/server/integrations/connections";
import { handlePayload, verifySignature } from "@/server/integrations/whatsapp";

type Ctx = { params: Promise<{ workspaceId: string }> };

// Meta calls this once when you save the webhook URL in the dashboard.
export async function GET(req: Request, { params }: Ctx) {
  const { workspaceId } = await params;
  const conn = await findConnection(workspaceId, "whatsapp");
  const q = new URL(req.url).searchParams;
  if (conn && q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === conn.secrets.verifyToken) {
    return new Response(q.get("hub.challenge") ?? "");
  }
  return new Response("Forbidden", { status: 403 });
}

// Every incoming message and delivery status.
export async function POST(req: Request, { params }: Ctx) {
  const { workspaceId } = await params;
  const conn = await findConnection(workspaceId, "whatsapp");
  if (!conn) return new Response("Not found", { status: 404 });

  const raw = await req.text(); // raw body: the signature is computed over these exact bytes
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), conn.secrets.appSecret)) {
    await logEvent({ workspaceId, provider: "whatsapp", direction: "in", type: "webhook", result: "rejected_signature" });
    return new Response("Forbidden", { status: 403 });
  }
  await handlePayload(workspaceId, JSON.parse(raw)); // a throw here → 500 → Meta retries later
  return new Response("OK");
}
