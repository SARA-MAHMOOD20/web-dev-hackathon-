# Integrations sandbox

All third-party integrations (WhatsApp, Stripe, Google Calendar, email), built and tested on their own while the main app is being built. At the end they get copied into the main app (see **Merging** below).

| Integration | Provider | Code |
| --- | --- | --- |
| Messaging (I1) | Meta WhatsApp Cloud API (replaces Twilio, which isn't free in Pakistan) | `src/server/integrations/whatsapp.ts` |
| Payments (I2) | Stripe, test mode | `src/server/integrations/stripe.ts` |
| Calendar (I3) | Google Calendar, OAuth 2.0 | `src/server/integrations/google.ts` |
| Notifications (I4) | Email via Resend | `src/server/integrations/email.ts` |
| Shared (I5) | Encrypted keys, sync log, retries | `connections.ts`, `crypto.ts`, `errors.ts` |

## Run it

```bash
npm install
cp .env.example .env              # then fill in; ENCRYPTION_KEY: openssl rand -base64 32
npx prisma db push                # creates the local SQLite database
node --env-file=.env prisma/seed.mjs
npm run dev                       # http://localhost:3000 is the test console
```

Webhooks need a public URL. In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the `https://….trycloudflare.com` URL it prints into `APP_URL` in `.env` and restart `npm run dev`. The URL changes every time cloudflared restarts, so update Meta and Stripe when it does.

## Connect each provider

The demo workspace ID is `ws_demo`. Keys are typed into the test console (section 1), stored encrypted, and never shown again in full.

**WhatsApp (Meta)**
1. developers.facebook.com → My Apps → Create App → use case "Connect with customers through WhatsApp".
2. WhatsApp → API Setup: copy the **Phone number ID**. Under "To", add each test phone (max 5).
3. Generate a permanent token: business.facebook.com → Settings → System users → add an Admin user, assign the app, then Generate token with `whatsapp_business_messaging` + `whatsapp_business_management`.
4. App Settings → Basic → **App secret**.
5. Save all four in the console. The verify token is any password you invent.
6. WhatsApp → Configuration → Webhook: Callback URL `https://<tunnel>/api/webhooks/whatsapp/ws_demo`, Verify token = the same one, then Verify and save. Subscribe to **messages**.
7. Send a WhatsApp message from a registered phone to the test number. It appears in section 2.

**Stripe**
1. dashboard.stripe.com in test mode → Developers → API keys → **Secret key**.
2. Developers → Webhooks → Add endpoint `https://<tunnel>/api/webhooks/stripe/ws_demo`. Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.payment_failed`, `charge.refunded`. Copy the **signing secret** (`whsec_…`).
3. Save both in the console, click Request payment, open Pay, and use card `4242 4242 4242 4242`. The row turns **paid** with no refresh. Card `4000 0000 0000 0002` gives a failed payment. A refund in the Stripe dashboard turns the row **refunded**.

**Email (Resend)**
1. resend.com → API Keys → create.
2. Save it in the console with From `LeadGuard <onboarding@resend.dev>`. Without a verified domain, Resend only delivers to your own signup address, so use that address as `SEED_EMAIL`.
3. Section 5 → Send a test escalation alert.

**Google Calendar**
1. console.cloud.google.com: new project → enable **Google Calendar API** → OAuth consent screen (External, Testing) → add test users → Data access: scopes `calendar.events`, `calendar.freebusy`, `openid`, `email`.
2. Clients → Create → Web application. Redirect URI: `http://localhost:3000/api/integrations/google/callback`.
3. Put the client ID and secret in `.env`, restart, then click Connect my Google Calendar in the console, open it at **localhost**, not the tunnel. Book in section 4.

## Checks the judges will try

| Check | How | Expected |
| --- | --- | --- |
| Forged webhook (I1.2, I2.3) | `curl -X POST https://<tunnel>/api/webhooks/whatsapp/ws_demo -d '{}'` | 403, logged as `rejected_signature` |
| Duplicate (I1.8, I2.4) | Stripe dashboard → the event → Resend | Logged as `duplicate`, one payment |
| Send failure (I1.7) | Message a phone that isn't on the allowed list | Message shows **failed** + reason + Retry |
| Opt-out (I1.9) | Customer replies `STOP`, then you reply | Blocked with an explanation |
| Busy slot (I3.4) | Book over an existing calendar event | Warning; tick "Book even if busy" to override |

## Merging into the main app

1. **Schema:** copy every model under `INTEGRATION MODELS` in `prisma/schema.prisma` into the main schema. The main app uses Postgres; the models need no changes.
2. **Code:** copy `src/server/integrations/`, `src/server/http.ts` and these route folders under `src/app/api/`: `webhooks`, `integrations`, `conversations`, `messages`, `opportunities`, `calendar`, `appointments`, `integration-events`. Don't copy `sandbox/` or `page.tsx`.
3. **Adapters:** `src/server/adapters.ts` holds stand-ins for five functions the main app owns: `requireUser`, `createLead`, `recordLeadAction`, `logActivity`, `audit`. Replace each body with an import of the real one. `createLead` must accept a Prisma transaction as its second argument.
4. **Escalation engine:** when a lead escalates, call `notifyEscalation({ workspaceId, userId, leadId, reason })`. In each sweep, call `retryFailedNotifications(workspaceId)`.
5. **Env:** add `ENCRYPTION_KEY`, `APP_URL`, `WHATSAPP_GRAPH_VERSION`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` to Vercel. Point the Meta and Stripe webhooks, and the Google redirect URI, at the Vercel URL. The real workspace ID replaces `ws_demo`.
6. `npm i stripe resend googleapis zod`
