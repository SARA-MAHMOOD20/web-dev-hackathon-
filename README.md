# LeadGuard

Multi-workspace CRM where every inbound lead has exactly one accountable owner,
an acknowledgement timer and automatic escalation. Integrates Twilio WhatsApp,
Stripe (test mode), Google Calendar and transactional email.

## Stack

Next.js (App Router) · TypeScript · Tailwind + shadcn/ui · Prisma · Neon Postgres · Vercel

## Setup

1. `cp .env.example .env.local` and fill in the values (ask the team for them).
2. `npm install`
3. `npx prisma generate`
4. `npm run dev` and open http://localhost:3000

Setup steps, seed data and demo credentials will be added as the app is built.
