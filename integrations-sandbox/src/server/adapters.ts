// ⚠️ MERGE POINT ─ stand-ins for functions the teammate owns.
// At merge, delete this file's bodies and re-export the real implementations:
//   export { requireUser } from "@/server/auth";  etc.
// The integration code only ever calls these five functions.
import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

type Tx = Prisma.TransactionClient;
export type CurrentUser = { id: string; workspaceId: string; name: string };

/** Real version: reads the session cookie, checks the permission, throws 401/403. */
export async function requireUser(_permission?: string): Promise<CurrentUser> {
  const user = await db.user.findUniqueOrThrow({ where: { id: "u_owner" } });
  return { id: user.id, workspaceId: user.workspaceId, name: user.name };
}

/** Real version: creates the lead AND runs round-robin assignment. Must accept `tx`. */
export async function createLead(
  input: { workspaceId: string; contactId: string; source: "whatsapp" | "web_form" | "manual" },
  tx: Tx = db,
) {
  return tx.lead.create({ data: { ...input, ownerId: "u_owner" } });
}

/** Real version: marks the contact's open lead as acknowledged (a message or appointment counts). */
export async function recordLeadAction(_input: { workspaceId: string; contactId: string; userId: string; kind: string }) {}

/** Real version: adds an entry to the contact/opportunity timeline (F2.7). */
export async function logActivity(
  input: { workspaceId: string; contactId: string; opportunityId?: string | null; type: string; actorId?: string | null; data?: unknown },
  tx: Tx = db,
) {
  await tx.activity.create({
    data: { ...input, opportunityId: input.opportunityId ?? null, actorId: input.actorId ?? null, data: JSON.stringify(input.data ?? {}) },
  });
}

/** Real version: writes an append-only audit row (F4.1). */
export async function audit(input: {
  workspaceId: string; actorId: string | null; action: string; targetType: string; targetId: string; before?: unknown; after?: unknown;
}) {
  console.log("[audit]", JSON.stringify(input));
}
