"use client";
// SANDBOX ONLY: a bare test console for the integrations. The teammate's real
// screens replace this; they call the same API routes.
import { useCallback, useEffect, useState } from "react";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data });
  return data;
}

const FIELDS: Record<string, [string, string][]> = {
  whatsapp: [["phoneNumberId", "Phone number ID"], ["accessToken", "Access token (permanent)"], ["appSecret", "App secret"], ["verifyToken", "Verify token (you invent it)"]],
  stripe: [["secretKey", "Secret key sk_test_…"], ["webhookSecret", "Webhook signing secret whsec_…"]],
  email: [["apiKey", "Resend API key re_…"], ["from", "From, e.g. LeadGuard <onboarding@resend.dev>"]],
};

export default function Sandbox() {
  const [s, setS] = useState<Json | null>(null);
  const [ints, setInts] = useState<Json[]>([]);
  const [events, setEvents] = useState<Json[]>([]);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [state, i, e] = await Promise.all([api("/api/sandbox/state"), api("/api/integrations"), api("/api/integration-events")]);
    setS(state); setInts(i.integrations); setEvents(e.events);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch for a polling dashboard
    load();
    const t = setInterval(load, 3000); // Q11: new messages and payment updates appear without refresh
    const g = new URLSearchParams(location.search).get("google");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-off message after the OAuth redirect
    if (g) setFlash({ ok: g === "connected", text: g === "connected" ? "Google Calendar connected." : g });
    return () => clearInterval(t);
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setFlash(null);
    try { await fn(); setFlash({ ok: true, text: `${label}: done` }); }
    catch (e) { setFlash({ ok: false, text: `${label}: ${(e as Error).message}` }); }
    finally { setBusy(false); load(); }
  }

  if (!s) return <main className="p-6">Loading…</main>;
  const contactName = (id: string) => s.contacts.find((c: Json) => c.id === id)?.name ?? id;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-4 text-sm sm:p-6">
      <header>
        <h1 className="text-2xl font-semibold">Integrations sandbox</h1>
        <p className="text-gray-500">Workspace <code>ws_demo</code> · refreshes every 3 s</p>
      </header>
      {flash && <p role="status" className={`rounded border p-3 ${flash.ok ? "border-green-600" : "border-red-600"}`}>{flash.ok ? "✓ " : "✗ "}{flash.text}</p>}

      <Section title="1. Connections">
        <div className="grid gap-4 md:grid-cols-2">
          {ints.filter((i) => i.provider !== "google").map((i) => (
            <form key={i.provider} className="space-y-2 rounded border p-3"
              onSubmit={(e) => { e.preventDefault(); const body = Object.fromEntries(new FormData(e.currentTarget));
                run(`Save ${i.provider}`, () => api(`/api/integrations/${i.provider}`, { method: "PUT", body: JSON.stringify(body) })); }}>
              <div className="flex items-center justify-between">
                <b className="capitalize">{i.provider}</b>
                <span>Status: <b>{i.status.replace("_", " ")}</b>{i.keyHint && <> · key <code>{i.keyHint}</code></>}</span>
              </div>
              <p className="text-gray-500">{i.limits}</p>
              {i.webhookUrl && <p>Webhook URL: <code className="break-all">{i.webhookUrl}</code></p>}
              <p className="text-gray-500">Last worked: {i.lastSuccessAt ? new Date(i.lastSuccessAt).toLocaleString() : "never"}</p>
              {i.lastError && <p className="text-red-700">Last error: {i.lastError}</p>}
              {FIELDS[i.provider].map(([name, label]) => (
                <label key={name} className="block">{label}
                  <input name={name} required type={name === "from" || name === "phoneNumberId" ? "text" : "password"} autoComplete="off" className="mt-1 w-full rounded border px-2 py-1" />
                </label>
              ))}
              <div className="flex gap-2">
                <button disabled={busy} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50">Save</button>
                {i.status !== "not_connected" && <button type="button" disabled={busy} className="rounded border px-3 py-1"
                  onClick={() => run(`Remove ${i.provider}`, () => api(`/api/integrations/${i.provider}`, { method: "DELETE" }))}>Remove</button>}
              </div>
            </form>
          ))}
          {ints.filter((i) => i.provider === "google").map((g) => (
            <div key="google" className="space-y-2 rounded border p-3">
              <b>Google Calendar</b>
              <p className="text-gray-500">{g.limits}</p>
              {g.employees.map((e: Json) => (
                <p key={e.userId}>{e.name}: <b>{e.status.replace("_", " ")}</b>{e.googleEmail && ` (${e.googleEmail})`}</p>
              ))}
              <div className="flex gap-2">
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a server redirect to Google, not a page */}
                <a href="/api/integrations/google/connect" className="rounded bg-black px-3 py-1 text-white">Connect my Google Calendar</a>
                <button type="button" className="rounded border px-3 py-1" onClick={() => run("Disconnect Google", () => api("/api/integrations/google", { method: "DELETE" }))}>Disconnect</button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="2. WhatsApp conversations">
        {s.conversations.length === 0 && <p className="text-gray-500">No conversations yet. Send a WhatsApp message to the Meta test number.</p>}
        {s.conversations.map((c: Json) => {
          const contact = s.contacts.find((x: Json) => x.id === c.contactId);
          return (
            <div key={c.id} className="space-y-2 rounded border p-3">
              <b>{contact?.name}</b> <span className="text-gray-500">+{contact?.phone}{contact?.optedOut && " · OPTED OUT"}</span>
              <ul className="space-y-1">
                {s.messages.filter((m: Json) => m.conversationId === c.id).map((m: Json) => (
                  <li key={m.id} className={m.direction === "out" ? "text-right" : ""}>
                    <span className="inline-block rounded border px-2 py-1">{m.body}</span>
                    <span className="ml-2 text-xs text-gray-500">{m.direction === "out" ? m.status : "received"}</span>
                    {m.status === "failed" && <span className="block text-xs text-red-700">Failed: {m.error}{" "}
                      <button className="underline" onClick={() => run("Retry", () => api(`/api/messages/${m.id}/retry`, { method: "POST" }))}>Retry</button></span>}
                  </li>
                ))}
              </ul>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget; const body = new FormData(f).get("body");
                run("Send", () => api(`/api/conversations/${c.id}/messages`, { method: "POST", body: JSON.stringify({ body }) })).then(() => f.reset()); }}>
                <label className="sr-only" htmlFor={`reply-${c.id}`}>Reply</label>
                <input id={`reply-${c.id}`} name="body" required placeholder="Type a reply" className="flex-1 rounded border px-2 py-1" />
                <button disabled={busy} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50">Send</button>
              </form>
            </div>
          );
        })}
        <p className="text-gray-500">Leads: {s.leads.map((l: Json) => `${contactName(l.contactId)} (${l.source})`).join(", ") || "none"}</p>
      </Section>

      <Section title="3. Stripe payments">
        {s.opportunities.map((o: Json) => (
          <form key={o.id} className="flex flex-wrap items-end gap-2 rounded border p-3" onSubmit={(e) => { e.preventDefault();
            const f = new FormData(e.currentTarget);
            run("Create payment link", () => api(`/api/opportunities/${o.id}/payments`, { method: "POST",
              body: JSON.stringify({ amount: Math.round(Number(f.get("amount")) * 100), currency: f.get("currency") }) })); }}>
            <b className="w-full">{o.title} · {contactName(o.contactId)}</b>
            <label>Amount<input name="amount" type="number" step="0.01" min="0.5" defaultValue="50" className="ml-1 w-24 rounded border px-2 py-1" /></label>
            <label>Currency<select name="currency" className="ml-1 rounded border px-2 py-1"><option>usd</option><option>eur</option><option>gbp</option></select></label>
            <button disabled={busy} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50">Request payment</button>
          </form>
        ))}
        <p>Collected this month (webhook-confirmed, minus refunds): {Object.entries(s.collected).map(([c, v]) => `${(Number(v) / 100).toFixed(2)} ${c.toUpperCase()}`).join(", ") || "0"}</p>
        <table className="w-full border text-left">
          <thead><tr><th className="p-1">Status</th><th>Amount</th><th>Contact</th><th>Stripe ref</th><th>Link</th></tr></thead>
          <tbody>{s.payments.map((p: Json) => (
            <tr key={p.id} className="border-t">
              <td className="p-1 font-semibold">{p.status}</td><td>{(p.amount / 100).toFixed(2)} {p.currency.toUpperCase()}</td>
              <td>{contactName(p.contactId)}</td><td className="break-all text-xs">{p.checkoutSessionId}</td>
              <td>{p.url && p.status === "pending" && <a className="underline" href={p.url} target="_blank" rel="noreferrer">Pay</a>}</td>
            </tr>))}</tbody>
        </table>
      </Section>

      <Section title="4. Google Calendar booking">
        <form className="flex flex-wrap items-end gap-2 rounded border p-3" onSubmit={(e) => { e.preventDefault();
          const f = new FormData(e.currentTarget); const start = new Date(String(f.get("start")));
          const body = { userId: s.users[0].id, contactId: f.get("contactId"), title: f.get("title"),
            startsAt: start.toISOString(), endsAt: new Date(start.getTime() + Number(f.get("mins")) * 60000).toISOString(), force: f.get("force") === "on" };
          run("Book", () => api("/api/appointments", { method: "POST", body: JSON.stringify(body) })); }}>
          <label>Contact<select name="contactId" className="ml-1 rounded border px-2 py-1">{s.contacts.map((c: Json) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Title<input name="title" required defaultValue="Property viewing" className="ml-1 rounded border px-2 py-1" /></label>
          <label>Start<input name="start" type="datetime-local" required className="ml-1 rounded border px-2 py-1" /></label>
          <label>Minutes<input name="mins" type="number" defaultValue="30" min="15" className="ml-1 w-16 rounded border px-2 py-1" /></label>
          <label><input name="force" type="checkbox" /> Book even if busy</label>
          <button disabled={busy} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50">Book</button>
        </form>
        <ul>{s.appointments.map((a: Json) => (
          <li key={a.id} className="flex flex-wrap gap-2 border-t py-1">
            <span>{a.title} · {contactName(a.contactId)} · {new Date(a.startsAt).toLocaleString(undefined, { timeZone: a.timeZone })} ({a.timeZone}) · <b>{a.status}</b></span>
            {a.status === "scheduled" && <>
              <button className="underline" onClick={() => run("Move +1 h", () => api(`/api/appointments/${a.id}`, { method: "PATCH",
                body: JSON.stringify({ startsAt: new Date(new Date(a.startsAt).getTime() + 3600e3).toISOString(), endsAt: new Date(new Date(a.endsAt).getTime() + 3600e3).toISOString() }) }))}>Move +1 h</button>
              <button className="underline" onClick={() => run("Cancel", () => api(`/api/appointments/${a.id}`, { method: "DELETE" }))}>Cancel</button>
            </>}
          </li>))}</ul>
      </Section>

      <Section title="5. Email escalation alerts">
        <div className="flex gap-2">
          <button disabled={busy} className="rounded bg-black px-3 py-1 text-white disabled:opacity-50" onClick={() => run("Test alert", () => api("/api/sandbox/test-escalation", { method: "POST" }))}>Send a test escalation alert</button>
          <button disabled={busy} className="rounded border px-3 py-1" onClick={() => run("Retry failed", () => api("/api/sandbox/retry-alerts", { method: "POST" }))}>Retry failed alerts</button>
        </div>
        <ul>{s.notifications.map((n: Json) => <li key={n.id} className="border-t py-1">{n.to} · <b>{n.status}</b> · attempts {n.attempts}{n.lastError && <span className="text-red-700"> · {n.lastError}</span>}</li>)}</ul>
      </Section>

      <Section title="6. Sync history (latest 100)">
        <table className="w-full border text-left text-xs">
          <thead><tr><th className="p-1">Time</th><th>Provider</th><th>Dir</th><th>Type</th><th>Result</th><th>Reference / error</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id} className="border-t">
              <td className="p-1">{new Date(e.createdAt).toLocaleTimeString()}</td><td>{e.provider}</td><td>{e.direction}</td><td>{e.type}</td>
              <td className={e.result === "ok" ? "" : "font-semibold text-red-700"}>{e.result}</td><td className="break-all">{e.error ?? e.reference}</td>
            </tr>))}</tbody>
        </table>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-3"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>;
}
