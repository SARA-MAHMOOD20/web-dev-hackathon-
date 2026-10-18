// Payments via Stripe Checkout in test mode (I2).
import Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";
import { logActivity } from "@/server/adapters";
import { getConnection, findConnection, logEvent, markError, markSuccess } from "./connections";
import { ProviderError, UserError } from "./errors";

const client = (secretKey: string) => new Stripe(secretKey, { maxNetworkRetries: 2 }); // I5.5: SDK retries network errors

/** I2.1: create a Checkout Session for an opportunity. Card details are typed only on Stripe's page (I2.8). */
export async function createPaymentLink(input: {
  workspaceId: string; opportunityId: string; userId: string; amount: number; currency: string;
}) {
  const { workspaceId } = input;
  const opp = await db.opportunity.findFirst({ where: { id: input.opportunityId, workspaceId } });
  if (!opp) throw new UserError("Opportunity not found.", 404);
  const { secrets } = await getConnection(workspaceId, "stripe");

  const payment = await db.payment.create({
    data: {
      workspaceId, opportunityId: opp.id, contactId: opp.contactId, requestedById: input.userId,
      amount: input.amount, currency: input.currency, status: "pending",
    },
  });
  const metadata = { workspaceId, paymentId: payment.id, opportunityId: opp.id };
  try {
    const session = await client(secrets.secretKey).checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: input.currency, unit_amount: input.amount, product_data: { name: opp.title } } }],
      success_url: `${process.env.APP_URL}/?paid=1`,
      cancel_url: `${process.env.APP_URL}/?cancelled=1`,
      metadata,
      payment_intent_data: { metadata }, // so card declines (payment_intent.payment_failed) map back to this payment
    });
    await markSuccess(workspaceId, "stripe");
    await logEvent({ workspaceId, provider: "stripe", direction: "out", type: "checkout.create", result: "ok", reference: session.id });
    await logActivity({
      workspaceId, contactId: opp.contactId, opportunityId: opp.id, type: "payment.requested", actorId: input.userId,
      data: { amount: input.amount, currency: input.currency },
    });
    return db.payment.update({ where: { id: payment.id }, data: { checkoutSessionId: session.id, url: session.url } });
  } catch (e) {
    await db.payment.delete({ where: { id: payment.id } }); // nothing was created at Stripe, so don't leave a ghost
    const message = explainStripeError(e);
    const permanent = e instanceof Stripe.errors.StripeAuthenticationError || e instanceof Stripe.errors.StripePermissionError;
    await markError(workspaceId, "stripe", message, permanent);
    await logEvent({ workspaceId, provider: "stripe", direction: "out", type: "checkout.create", result: "error", error: message });
    throw new ProviderError(message, !permanent);
  }
}

/** I2.2–I2.5: verify the signature BEFORE touching anything, then apply each event exactly once. */
export async function handleWebhook(workspaceId: string, rawBody: string, signature: string | null) {
  const conn = await findConnection(workspaceId, "stripe");
  if (!conn) return { status: 404, body: { error: "Stripe not connected" } };

  let event: Stripe.Event;
  try {
    event = client(conn.secrets.secretKey).webhooks.constructEvent(rawBody, signature ?? "", conn.secrets.webhookSecret);
  } catch {
    await logEvent({ workspaceId, provider: "stripe", direction: "in", type: "webhook", result: "rejected_signature" });
    return { status: 400, body: { error: "Invalid signature" } };
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { provider: "stripe", eventId: event.id } }); // 2nd delivery → P2002
      await apply(tx, workspaceId, event);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      await logEvent({ workspaceId, provider: "stripe", direction: "in", type: event.type, result: "duplicate", reference: event.id });
      return { status: 200, body: { duplicate: true } };
    }
    throw e; // 500 → Stripe retries later
  }
  await markSuccess(workspaceId, "stripe");
  await logEvent({ workspaceId, provider: "stripe", direction: "in", type: event.type, result: "ok", reference: event.id });
  return { status: 200, body: { received: true } };
}

async function apply(tx: Prisma.TransactionClient, workspaceId: string, event: Stripe.Event) {
  const set = async (where: Prisma.PaymentWhereInput, data: Prisma.PaymentUpdateManyMutationInput, activity: string) => {
    const payment = await tx.payment.findFirst({ where: { ...where, workspaceId } });
    if (!payment) return;
    await tx.payment.update({ where: { id: payment.id }, data });
    await logActivity({
      workspaceId, contactId: payment.contactId, opportunityId: payment.opportunityId, type: activity,
      data: { amount: payment.amount, currency: payment.currency, reference: payment.checkoutSessionId },
    }, tx);
  };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object;
      const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null;
      if (s.payment_status === "paid") {
        await set({ checkoutSessionId: s.id }, { status: "paid", paidAt: new Date(), paymentIntentId: pi }, "payment.paid");
      } else {
        await tx.payment.updateMany({ where: { workspaceId, checkoutSessionId: s.id }, data: { paymentIntentId: pi } });
      }
      break;
    }
    case "checkout.session.async_payment_failed":
      await set({ checkoutSessionId: event.data.object.id }, { status: "failed" }, "payment.failed");
      break;
    case "checkout.session.expired":
      await set({ checkoutSessionId: event.data.object.id, status: "pending" }, { status: "expired" }, "payment.expired");
      break;
    case "payment_intent.payment_failed": {
      const paymentId = event.data.object.metadata?.paymentId;
      if (paymentId) await set({ id: paymentId, status: "pending" }, { status: "failed" }, "payment.failed");
      break;
    }
    case "charge.refunded": {
      const c = event.data.object;
      const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
      if (pi) {
        await set(
          { paymentIntentId: pi },
          { status: c.amount_refunded >= c.amount ? "refunded" : "partially_refunded", refundedAmount: c.amount_refunded },
          "payment.refunded",
        );
      }
      break;
    }
  }
}

function explainStripeError(e: unknown) {
  if (e instanceof Stripe.errors.StripeAuthenticationError) return "Stripe rejected the API key. Update it on the Integrations page.";
  if (e instanceof Stripe.errors.StripeConnectionError) return "Could not reach Stripe. Try again in a moment.";
  if (e instanceof Stripe.errors.StripeRateLimitError) return "Stripe rate limit reached. Try again in a minute.";
  if (e instanceof Stripe.errors.StripeInvalidRequestError) return `Stripe rejected the request: ${e.message}`;
  if (e instanceof Stripe.errors.StripeError) return `Stripe error: ${e.message}`;
  return "Unexpected error while creating the payment link.";
}

/** I2.6: collected = paid minus refunds, from webhook-confirmed payments only. */
export async function collectedRevenue(workspaceId: string, since: Date) {
  const rows = await db.payment.findMany({
    where: { workspaceId, paidAt: { gte: since }, status: { in: ["paid", "refunded", "partially_refunded"] } },
    select: { amount: true, refundedAmount: true, currency: true },
  });
  const byCurrency: Record<string, number> = {};
  for (const r of rows) byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + r.amount - r.refundedAmount;
  return byCurrency;
}
