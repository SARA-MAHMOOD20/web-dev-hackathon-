import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ProviderError, UserError } from "@/server/integrations/errors";

/** Wraps a route handler: turns thrown errors into JSON with a plain message (Q10). */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof UserError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
      if (e instanceof ProviderError) return NextResponse.json({ error: e.message }, { status: 502 });
      console.error(e);
      return NextResponse.json({ error: "Something went wrong on our side. Try again." }, { status: 500 });
    }
  };
}
