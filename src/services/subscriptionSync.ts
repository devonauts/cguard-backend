/**
 * Seat reconciliation — keeps each active tenant's Stripe subscription quantity
 * in sync with its current billable-user count. Stripe prorates the difference
 * onto the next monthly invoice, so adding/removing users is billed correctly.
 *
 * The per-seat subscription item is resolved lazily (largest recurring
 * unit_amount — the $5.15 seat line vs the $0.31 processing line) and cached on
 * tenant.stripeSeatItemId.
 */
import { getConfig } from '../config';
import { countBillableSeats } from './subscriptionService';

export async function syncSeatsForTenant(db: any, tenant: any): Promise<any> {
  const secret = getConfig().PLAN_STRIPE_SECRET_KEY;
  if (!secret || !tenant?.stripeSubscriptionId) return { skipped: true, reason: 'not_configured' };

  const stripe = require('stripe')(secret);

  let itemId = tenant.stripeSeatItemId || null;
  if (!itemId) {
    const sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
    const items = (sub.items && sub.items.data) || [];
    let seat: any = null;
    for (const it of items) {
      if (!it.price || !it.price.recurring) continue;
      const amt = it.price.unit_amount || 0;
      if (!seat || amt > (seat.price.unit_amount || 0)) seat = it;
    }
    itemId = seat ? seat.id : null;
    if (itemId) {
      await db.tenant.update({ stripeSeatItemId: itemId }, { where: { id: tenant.id } });
    }
  }
  if (!itemId) return { skipped: true, reason: 'no_seat_item' };

  const item = await stripe.subscriptionItems.retrieve(itemId);
  const seats = Math.max(1, await countBillableSeats(db, tenant.id));

  if (item.quantity !== seats) {
    await stripe.subscriptionItems.update(itemId, {
      quantity: seats,
      proration_behavior: 'create_prorations',
    });
    return { updated: true, from: item.quantity, to: seats };
  }
  return { updated: false, seats };
}

export async function reconcileAllSubscriptions(db: any): Promise<{ tenants: number; updated: number }> {
  const { Op } = require('sequelize');
  const tenants = await db.tenant.findAll({
    where: { billingStatus: 'active', stripeSubscriptionId: { [Op.ne]: null } },
  });
  let updated = 0;
  for (const t of tenants) {
    try {
      const r = await syncSeatsForTenant(db, t.get ? t.get({ plain: true }) : t);
      if (r && r.updated) {
        updated += 1;
        console.log(`[seatSync] tenant ${t.id}: ${r.from} → ${r.to} seats`);
      }
    } catch (e: any) {
      console.warn('[seatSync] tenant', t.id, e?.message || e);
    }
  }
  return { tenants: (tenants || []).length, updated };
}
