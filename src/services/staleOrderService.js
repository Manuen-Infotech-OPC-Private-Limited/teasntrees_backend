import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { notificationService } from './notificationService.js';
import { SOCKET_EVENTS, SOCKET_ROOMS } from '../sockets/socketEvents.js';

/**
 * Closes out orders that nobody finished.
 *
 * THE GAP THIS FILLS
 * ------------------
 * An order only ends when someone ends it: the rider taps "delivered", or
 * staff cancel it. If neither happens — the rider's phone died after the
 * hand-over, the kitchen forgot a pending order, a test order was abandoned —
 * the order sits in a live status forever. The escalation monitor and the
 * delivery watchdog alert people in the first few minutes, but neither ever
 * ends the order, so months later the customer's app was still telling them
 * it was "on the way".
 *
 * WHAT IT DOES
 * ------------
 * Two steps, a day apart, so a human gets the chance to do the right thing
 * first:
 *
 *  1. FLAG — no activity for FLAG_AFTER_MS: stamp `staleFlaggedAt` and tell
 *     admins and managers. Nothing else changes. They can still mark it
 *     delivered (it may well have been, cash collected and all) or cancel it
 *     with a proper reason.
 *  2. CANCEL — still untouched CANCEL_AFTER_FLAG_MS after the flag: cancel the
 *     order and its delivery, free the rider, and tell the customer's app.
 *
 * "Activity" is the order's `updatedAt`. The flag is written without touching
 * `updatedAt`, so flagging an order doesn't itself count as activity; if
 * anything else changes the order after the flag, the flag is dropped and the
 * clock starts again.
 *
 * Coupon use is deliberately not refunded here (unlike a customer's own
 * cancellation): an order that reached this point may have been delivered.
 */
class StaleOrderService {
    constructor() {
        this.io = null;

        this.CONFIG = {
            TICK_MS: 15 * 60 * 1000,
            FLAG_AFTER_MS: 24 * 60 * 60 * 1000,
            CANCEL_AFTER_FLAG_MS: 24 * 60 * 60 * 1000,
            // Per tick. The first run after deploy meets every order abandoned
            // before this existed; work through them in batches.
            BATCH: 100
        };

        this.TERMINAL = ['delivered', 'cancelled'];
        this.CANCEL_REASON = 'Closed automatically: no activity for 48 hours';
    }

    initialize(io) {
        this.io = io;

        if (process.env.ENABLE_BACKGROUND_JOBS === 'false') {
            logger.info('[StaleOrders] Disabled via ENABLE_BACKGROUND_JOBS=false');
            return;
        }

        logger.info('[StaleOrders] Starting stale-order monitor...');
        const tick = () =>
            this.run().catch((err) =>
                logger.error('[StaleOrders] tick failed', { error: err.message })
            );
        // Shortly after boot, then on the interval.
        setTimeout(tick, 60 * 1000);
        setInterval(tick, this.CONFIG.TICK_MS);
    }

    async run(now = Date.now()) {
        const cancelled = await this.cancelFlagged(now);
        const flagged = await this.flagStale(now);
        return { flagged, cancelled };
    }

    /** Step 1: flag orders that have gone quiet, and tell staff. */
    async flagStale(now) {
        const Order = mongoose.model('Order');
        const User = mongoose.model('User');
        const cutoff = new Date(now - this.CONFIG.FLAG_AFTER_MS);

        const stale = await Order.find({
            status: { $nin: this.TERMINAL },
            updatedAt: { $lt: cutoff },
            staleFlaggedAt: null
        })
            .select('_id orderNumber brand status updatedAt')
            .limit(this.CONFIG.BATCH)
            .lean();

        if (stale.length === 0) return 0;

        // timestamps:false — flagging must not count as activity on the order.
        await Order.updateMany(
            { _id: { $in: stale.map((o) => o._id) }, staleFlaggedAt: null },
            { $set: { staleFlaggedAt: new Date(now) } },
            { timestamps: false }
        );

        logger.warn('[StaleOrders] Flagged orders with no activity for 24h', {
            count: stale.length,
            orders: stale.map((o) => o.orderNumber)
        });

        this.io
            ?.to(SOCKET_ROOMS.role('admin'))
            .to(SOCKET_ROOMS.role('manager'))
            .emit('order:stale', {
                orders: stale.map((o) => ({
                    orderId: o._id.toString(),
                    orderNumber: o.orderNumber,
                    brand: o.brand,
                    status: o.status,
                    lastActivity: o.updatedAt
                })),
                cancelsAt: new Date(now + this.CONFIG.CANCEL_AFTER_FLAG_MS)
            });

        // One push however many there are, so a backlog doesn't become a storm.
        const body =
            stale.length === 1
                ? `Order #${stale[0].orderNumber} has had no activity for 24 hours. Close it out, or it will be cancelled automatically in 24 hours.`
                : `${stale.length} orders have had no activity for 24 hours. Close them out, or they will be cancelled automatically in 24 hours.`;

        await notificationService.notifyAdmins(User, {
            title: 'Unfinished orders need closing',
            body,
            data: { type: 'order_stale', count: String(stale.length) }
        });

        return stale.length;
    }

    /** Step 2: cancel orders that stayed untouched for a day after the flag. */
    async cancelFlagged(now) {
        const Order = mongoose.model('Order');
        const cutoff = new Date(now - this.CONFIG.CANCEL_AFTER_FLAG_MS);

        // Something happened to the order after it was flagged: it isn't
        // abandoned after all. Drop the flag so the clock starts again.
        await Order.updateMany(
            {
                staleFlaggedAt: { $ne: null },
                $expr: { $gt: ['$updatedAt', '$staleFlaggedAt'] }
            },
            { $set: { staleFlaggedAt: null } },
            { timestamps: false }
        );

        const due = await Order.find({
            status: { $nin: this.TERMINAL },
            staleFlaggedAt: { $ne: null, $lt: cutoff }
        })
            .select('_id')
            .limit(this.CONFIG.BATCH)
            .lean();

        let cancelled = 0;
        for (const { _id } of due) {
            try {
                if (await this._cancelOne(_id, now)) cancelled++;
            } catch (err) {
                logger.error('[StaleOrders] failed to cancel order', {
                    orderId: _id.toString(),
                    error: err.message
                });
            }
        }
        return cancelled;
    }

    async _cancelOne(orderId, now) {
        const Order = mongoose.model('Order');
        const Delivery = mongoose.model('Delivery');
        const Rider = mongoose.model('Rider');

        // The filter repeats the conditions, so an order someone closed between
        // the query and now is left alone.
        const order = await Order.findOneAndUpdate(
            {
                _id: orderId,
                status: { $nin: this.TERMINAL },
                staleFlaggedAt: { $ne: null }
            },
            {
                $set: {
                    status: 'cancelled',
                    cancelReason: this.CANCEL_REASON,
                    cancelledAt: new Date(now)
                },
                $push: {
                    timeline: {
                        status: 'cancelled',
                        timestamp: new Date(now),
                        description: this.CANCEL_REASON
                    }
                }
            },
            { returnDocument: 'after' }
        );
        if (!order) return false;

        // A plain update rather than load-and-save: deliveries from before a
        // field became required would fail validation on save, leaving the
        // order cancelled but the delivery live and the rider stuck as busy.
        // It also skips the delivery's save hooks, so the rider is freed here.
        const delivery = await Delivery.findOneAndUpdate(
            {
                orderId: order._id,
                status: { $nin: ['delivered', 'cancelled', 'rejected'] }
            },
            {
                $set: {
                    status: 'cancelled',
                    cancelReason: this.CANCEL_REASON,
                    cancelledAt: new Date(now)
                }
            },
            { returnDocument: 'after' }
        );
        if (delivery?.riderId) {
            await Rider.findByIdAndUpdate(delivery.riderId, { isOnDelivery: false });
            this.io?.to(SOCKET_ROOMS.user(delivery.riderId.toString())).emit('delivery:cancelled', {
                deliveryId: delivery._id.toString(),
                reason: this.CANCEL_REASON
            });
        }

        logger.warn('[StaleOrders] Cancelled abandoned order', {
            orderId: order._id.toString(),
            orderNumber: order.orderNumber,
            deliveryId: delivery?._id.toString() ?? null
        });

        this.io
            ?.to(SOCKET_ROOMS.user(order.customerId.toString()))
            .to(SOCKET_ROOMS.order(order._id.toString()))
            .to(SOCKET_ROOMS.role('admin'))
            .to(SOCKET_ROOMS.role('manager'))
            .emit(SOCKET_EVENTS.ORDER_STATUS_UPDATED, {
                orderId: order._id,
                status: 'cancelled',
                reason: this.CANCEL_REASON
            });

        return true;
    }
}

export const staleOrderService = new StaleOrderService();
