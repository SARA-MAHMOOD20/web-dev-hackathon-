import { z } from "zod";
import { db } from "@/server/db";
import { audit } from "@/server/adapters";
import { decrypt, encrypt } from "./crypto";
import { UserError } from "./errors";

// What each provider needs. Validated on save (Q3), stored encrypted (I5.3).
export const secretSchemas = {
  whatsapp: z.object({
    phoneNumberId: z.string().regex(/^\d+$/, "Phone number ID is digits only"),
    accessToken: z.string().min(20),
    appSecret: z.string().min(16),
    verifyToken: z.string().min(8),
  }),
  stripe: z.object({
    secretKey: z.string().startsWith("sk_test_", "Use a test-mode key (sk_test_…)"),
    webhookSecret: z.string().startsWith("whsec_"),
  }),
  email: z.object({
    apiKey: z.string().startsWith("re_"),
    from: z.string().min(3), // e.g. "LeadGuard <onboarding@resend.dev>"
  }),
};
export type Provider = keyof typeof secretSchemas;
export type Secrets<P extends Provider> = z.infer<(typeof secretSchemas)[P]>;
export const PROVIDERS = Object.keys(secretSchemas) as Provider[];

// I5.6: what each integration can and cannot do, shown on the Integrations page.
export const LIMITS: Record<Provider | "google", string> = {
  whatsapp: "Meta test number: can only message up to 5 phone numbers registered in the Meta dashboard. Free-text replies only within 24 h of the customer's last message.",
  stripe: "Test mode only: no real money. Pay with card 4242 4242 4242 4242. Card details are entered on Stripe's page, never here.",
  email: "Without a verified domain, Resend only delivers to the account owner's own address.",
  google: "App is in Testing: only Google accounts listed as test users can connect. Each employee connects their own calendar.",
};

const LABEL: Record<Provider, string> = { whatsapp: "WhatsApp", stripe: "Stripe", email: "Email" };
const HINT_FIELD: Record<Provider, string> = { whatsapp: "accessToken", stripe: "secretKey", email: "apiKey" };

export function mask(s: string) {
  if (s.length <= 12) return "••••";
  const head = s.match(/^(sk_test_|whsec_|re_)/)?.[0] ?? s.slice(0, 4);
  return `${head}…${s.slice(-4)}`;
}

export async function getConnection<P extends Provider>(workspaceId: string, provider: P) {
  const row = await db.integrationConnection.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  if (!row || row.status === "not_connected") {
    throw new UserError(`${LABEL[provider]} is not connected for this workspace. An admin can connect it on the Integrations page.`, 409);
  }
  return { ...row, secrets: JSON.parse(decrypt(row.secrets)) as Secrets<P> };
}

/** Same as getConnection, but null instead of throwing (for webhooks). */
export async function findConnection<P extends Provider>(workspaceId: string, provider: P) {
  try {
    return await getConnection(workspaceId, provider);
  } catch {
    return null;
  }
}

export async function saveConnection(workspaceId: string, provider: Provider, input: unknown, actorId: string) {
  const secrets = secretSchemas[provider].parse(input) as Record<string, string>;
  const keyHint = mask(secrets[HINT_FIELD[provider]]);
  const before = await db.integrationConnection.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  await db.integrationConnection.upsert({
    where: { workspaceId_provider: { workspaceId, provider } },
    create: { workspaceId, provider, secrets: encrypt(JSON.stringify(secrets)), keyHint, status: "connected" },
    update: { secrets: encrypt(JSON.stringify(secrets)), keyHint, status: "connected", lastError: null },
  });
  await audit({
    workspaceId, actorId, action: before ? "integration.updated" : "integration.connected", targetType: "integration", targetId: provider,
    before: before ? { keyHint: before.keyHint, status: before.status } : null, after: { keyHint, status: "connected" },
  });
}

export async function removeConnection(workspaceId: string, provider: Provider, actorId: string) {
  await db.integrationConnection.updateMany({
    where: { workspaceId, provider },
    data: { status: "not_connected", secrets: encrypt("{}"), keyHint: null },
  });
  await audit({ workspaceId, actorId, action: "integration.removed", targetType: "integration", targetId: provider });
}

export async function markSuccess(workspaceId: string, provider: Provider) {
  await db.integrationConnection.updateMany({
    where: { workspaceId, provider, status: { not: "not_connected" } },
    data: { status: "connected", lastSuccessAt: new Date(), lastError: null },
  });
}

/** Only permanent errors (bad key, bad config) flip the status to "error". */
export async function markError(workspaceId: string, provider: Provider, message: string, permanent: boolean) {
  await db.integrationConnection.updateMany({
    where: { workspaceId, provider, status: { not: "not_connected" } },
    data: { lastError: message, ...(permanent ? { status: "error" } : {}) },
  });
}

/** I5.4: every inbound webhook and outbound call gets a row. */
export async function logEvent(e: {
  workspaceId: string; provider: Provider | "google"; direction: "in" | "out"; type: string;
  result: "ok" | "duplicate" | "rejected_signature" | "error" | "ignored"; reference?: string | null; error?: string | null;
}) {
  await db.integrationEvent.create({ data: { ...e, reference: e.reference ?? null, error: e.error ?? null } });
}
