// Seeds one demo workspace with fixed IDs so webhook URLs stay stable:
//   /api/webhooks/whatsapp/ws_demo   /api/webhooks/stripe/ws_demo
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

await db.workspace.upsert({ where: { id: "ws_demo" }, update: {}, create: { id: "ws_demo", name: "Demo Realty" } });
await db.user.upsert({
  where: { id: "u_owner" }, update: {},
  create: { id: "u_owner", workspaceId: "ws_demo", name: "Sarah (Owner)", email: process.env.SEED_EMAIL ?? "owner@example.com" },
});
await db.contact.upsert({
  where: { id: "c_demo" }, update: {},
  create: { id: "c_demo", workspaceId: "ws_demo", name: "Ali Khan", email: "ali@example.com" },
});
await db.opportunity.upsert({
  where: { id: "o_demo" }, update: {},
  create: { id: "o_demo", workspaceId: "ws_demo", contactId: "c_demo", title: "3-bed apartment, DHA", value: 5000, ownerId: "u_owner" },
});
await db.lead.upsert({
  where: { id: "l_demo" }, update: {},
  create: { id: "l_demo", workspaceId: "ws_demo", contactId: "c_demo", source: "manual", ownerId: "u_owner" },
});
console.log("Seeded workspace ws_demo");
await db.$disconnect();
