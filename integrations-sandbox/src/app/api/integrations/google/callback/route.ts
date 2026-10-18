import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireUser } from "@/server/adapters";
import { finishConnect } from "@/server/integrations/google";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (msg: string) => NextResponse.redirect(new URL(`/?google=${encodeURIComponent(msg)}`, url));
  const jar = await cookies();
  const expected = jar.get("g_oauth_state")?.value;
  jar.delete("g_oauth_state");

  if (url.searchParams.get("error")) return back("You cancelled the Google connection.");
  if (!expected || url.searchParams.get("state") !== expected) return back("Connection expired or was tampered with. Try again.");
  try {
    await finishConnect(await requireUser(), url.searchParams.get("code") ?? "");
    return back("connected");
  } catch (e) {
    return back(e instanceof Error ? e.message : "Google connection failed.");
  }
}
