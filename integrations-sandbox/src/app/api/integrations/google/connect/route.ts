import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/adapters";
import { handle } from "@/server/http";
import { consentUrl } from "@/server/integrations/google";

export const GET = handle(async () => {
  await requireUser(); // each employee connects their own calendar
  const state = crypto.randomBytes(16).toString("hex");
  (await cookies()).set("g_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 600, path: "/" });
  return NextResponse.redirect(consentUrl(state));
});
