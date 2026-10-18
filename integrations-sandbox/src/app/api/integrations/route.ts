import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { LIMITS, PROVIDERS } from "@/server/integrations/connections";

// I5.1: status, last success, recent errors per integration. Secrets never leave the server.
export const GET = handle(async () => {
  const user = await requireUser("integrations.manage");
  const { workspaceId } = user;
  const rows = await db.integrationConnection.findMany({ where: { workspaceId } });
  const recentErrors = await db.integrationEvent.findMany({
    where: { workspaceId, result: { in: ["error", "rejected_signature"] } }, orderBy: { createdAt: "desc" }, take: 30,
  });
  const google = await db.googleAccount.findMany({ where: { workspaceId } });
  const users = await db.user.findMany({ where: { workspaceId }, select: { id: true, name: true } });

  return NextResponse.json({
    integrations: [
      ...PROVIDERS.map((provider) => {
        const r = rows.find((x) => x.provider === provider);
        return {
          provider,
          status: r?.status ?? "not_connected",
          keyHint: r?.keyHint ?? null,
          lastSuccessAt: r?.lastSuccessAt ?? null,
          lastError: r?.lastError ?? null,
          webhookUrl: provider === "email" ? null : `${process.env.APP_URL}/api/webhooks/${provider}/${workspaceId}`,
          limits: LIMITS[provider],
          recentErrors: recentErrors.filter((e) => e.provider === provider).slice(0, 5),
        };
      }),
      {
        provider: "google",
        // I3.7: calendar status per employee, visible to admins
        employees: users.map((u) => {
          const g = google.find((x) => x.userId === u.id);
          return { userId: u.id, name: u.name, status: g?.status ?? "not_connected", googleEmail: g?.googleEmail ?? null, isMe: u.id === user.id };
        }),
        limits: LIMITS.google,
        recentErrors: recentErrors.filter((e) => e.provider === "google").slice(0, 5),
      },
    ],
  });
});
