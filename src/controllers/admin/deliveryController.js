import Delivery from '../../models/Delivery.js';
import Order from '../../models/Order.js';
import Rider from '../../models/Rider.js';
import User from '../../models/User.js';
import logger from '../../config/logger.js';
import activityLogService from '../../services/activityLogService.js';
import { riderAssignmentService } from '../../services/riderAssignmentService.js';
import { SOCKET_ROOMS } from '../../sockets/socketEvents.js';

/* ----------------------------------
   GET ALL DELIVERIES (ADMIN)
----------------------------------- */
export const getAllDeliveries = async (req, res) => {
    try {
        const { status, riderId, startDate, endDate, search } = req.query;
        const brand = req.activeBrand;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const query = {};
        if (status) query.status = status;
        if (riderId) query.riderId = riderId;
        if (brand) query.brand = brand;

        if (search) {
            const s = search.trim();
            const [matchingOrders, matchingRiders, matchingUsers] = await Promise.all([
                Order.find({ orderNumber: { $regex: s, $options: 'i' } }).select('_id'),
                Rider.find({
                    $or: [
                        { name: { $regex: s, $options: 'i' } },
                        { mobile: { $regex: s, $options: 'i' } }
                    ]
                }).select('_id'),
                User.find({
                    $or: [
                        { name: { $regex: s, $options: 'i' } },
                        { mobile: { $regex: s, $options: 'i' } }
                    ]
                }).select('_id')
            ]);

            query.$or = [
                { orderId: { $in: matchingOrders.map(o => o._id) } },
                { riderId: { $in: matchingRiders.map(r => r._id) } },
                { customerId: { $in: matchingUsers.map(u => u._id) } }
            ];
        }

        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) {
                const start = new Date(startDate);
                start.setHours(0, 0, 0, 0);
                query.createdAt.$gte = start;
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }

        const deliveries = await Delivery.find(query)
            .populate('orderId', 'orderNumber total status brand')
            .populate('riderId', 'name mobile')
            .populate('customerId', 'name mobile')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Delivery.countDocuments(query);

        res.json({
            success: true,
            data: deliveries,
            pagination: {
                page,
                totalPages: Math.ceil(total / limit),
                totalItems: total
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/* ----------------------------------
   GET DELIVERY BY ID (ADMIN)
----------------------------------- */
export const getDeliveryById = async (req, res) => {
    try {
        const delivery = await Delivery.findById(req.params.id)
            .populate('orderId')
            .populate('riderId', 'name mobile')
            .populate('customerId', 'name mobile');

        if (!delivery) {
            return res.status(404).json({ success: false, message: 'Delivery not found' });
        }

        res.json({ success: true, data: delivery });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/* ----------------------------------
   ADMIN: CANCEL DELIVERY (SAFE)
----------------------------------- */
export const cancelDelivery = async (req, res) => {
    try {
        const { reason } = req.body;

        const delivery = await Delivery.findById(req.params.id);
        if (!delivery) {
            return res.status(404).json({ success: false, message: 'Delivery not found' });
        }

        if (['delivered', 'cancelled'].includes(delivery.status)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot cancel a completed delivery'
            });
        }

        delivery.status = 'cancelled';
        delivery.cancelReason = reason || 'Cancelled by admin';
        delivery.cancelledAt = new Date();

        await delivery.save(); // 🔥 Order sync happens automatically

        // Free the rider. Without this they stay flagged isOnDelivery forever
        // and silently stop receiving any new orders.
        if (delivery.riderId) {
            await Rider.findByIdAndUpdate(delivery.riderId, { isOnDelivery: false });
        }

        res.json({
            success: true,
            message: 'Delivery cancelled successfully',
            data: delivery
        });

        // Log Activity
        await activityLogService.log(req, {
            action: 'cancel',
            resource: 'delivery',
            resourceId: delivery._id,
            details: { reason: delivery.cancelReason }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/* ----------------------------------
   DELIVERY STATISTICS (ADMIN)
----------------------------------- */
export const getDeliveryStats = async (req, res) => {
    try {
        const brand = req.activeBrand;
        const query = {};

        if (brand) {
            query.brand = brand;
        }

        const [
            totalDeliveries,
            activeDeliveries,
            completedDeliveries,
            cancelledDeliveries
        ] = await Promise.all([
            Delivery.countDocuments(query),
            Delivery.countDocuments({
                ...query,
                status: {
                    $in: [
                        'new',
                        'assigned_for_pickup',
                        'assigned_for_seller_pickup',
                        'ofp',
                        'picked',
                        'item_manifested',
                        'bag_in_transit',
                        'bag_received_at_via',
                        'bag_received',
                        'recd_at_fwd_hub',
                        'recd_at_fwd_dc',
                        'assigned_for_delivery',
                        'ofd',
                        'in_transit',
                        'on_hold',
                        'pickup_on_hold',
                        'reopen_ndr',
                        'cid',
                        'nc',
                        'na'
                    ]
                }
            }),
            Delivery.countDocuments({ ...query, status: 'delivered' }),
            Delivery.countDocuments({
                ...query,
                status: { $in: ['cancelled', 'cancelled_by_seller', 'cancelled_by_customer', 'lost', 'rto', 'rto_d', 'rts', 'rts_d'] }
            })
        ]);

        const earnings = await Delivery.aggregate([
            { $match: { ...query, status: 'delivered' } },
            { $group: { _id: null, total: { $sum: '$totalEarning' } } }
        ]);

        res.json({
            success: true,
            data: {
                totalDeliveries,
                activeDeliveries,
                completedDeliveries,
                cancelledDeliveries,
                totalEarnings: earnings[0]?.total || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/* ----------------------------------
   REASSIGN A STALLED DELIVERY (ADMIN)

   The recovery action for the case deliveryWatchdogService escalates: a rider
   accepted an order and then stopped moving toward the store or the customer.
   Until now there was no way out of that state at all — the rider cannot
   release an accepted order (`reject` only applies to the pre-acceptance
   offer), they cannot go offline while holding one, and no admin endpoint
   existed to take it off them. The only recovery was editing the database.

   Takes the delivery off the rider, frees them for future orders, and puts the
   order back in the pool, excluding the rider we just pulled it from so it
   isn't handed straight back to them.
----------------------------------- */
export const reassignDelivery = async (req, res) => {
    try {
        const { reason } = req.body;

        const delivery = await Delivery.findById(req.params.id).populate('orderId');
        if (!delivery) {
            return res.status(404).json({ success: false, message: 'Delivery not found' });
        }

        if (['delivered', 'cancelled'].includes(delivery.status)) {
            return res.status(400).json({
                success: false,
                message: 'That delivery is already finished.'
            });
        }

        const previousRiderId = delivery.riderId;

        delivery.status = 'cancelled';
        delivery.cancelReason = reason || 'Reassigned by admin: rider not moving';
        delivery.cancelledAt = new Date();
        await delivery.save();

        // Free the rider, or they stay flagged as on-delivery forever and never
        // receive another order. (The existing cancelDelivery had this bug.)
        if (previousRiderId) {
            await Rider.findByIdAndUpdate(previousRiderId, { isOnDelivery: false });
        }

        const io = req.app.get('io');

        // Tell the rider their order is gone, so the app clears it rather than
        // leaving a dead delivery pinned to their map.
        if (previousRiderId && io) {
            io.to(SOCKET_ROOMS.user(previousRiderId.toString())).emit('delivery:cancelled', {
                deliveryId: delivery._id.toString(),
                reason: delivery.cancelReason
            });
        }

        const result = await riderAssignmentService.assignRiderWithRetry(
            delivery.orderId,
            io,
            {
                orderId: delivery.orderId?._id ?? delivery.orderId,
                customerId: delivery.customerId,
                pickupLocation: delivery.pickupLocation,
                deliveryLocation: delivery.deliveryLocation,
                distance: delivery.distance,
                baseEarning: delivery.baseEarning,
                distanceBonus: delivery.distanceBonus,
                surgeBonus: delivery.surgeBonus,
                totalEarning: delivery.totalEarning
                // NB: deliberately NOT carrying over pickupOtp/deliveryOtp — the
                // new rider gets fresh codes, so the pulled rider can't walk up
                // to the outlet later with a code that still works.
            },
            previousRiderId ? [previousRiderId] : []
        );

        await activityLogService.log(req, {
            action: 'reassign',
            resource: 'delivery',
            resourceId: delivery._id,
            details: { reason: delivery.cancelReason, previousRiderId }
        });

        return res.json({
            success: true,
            message: result?.success
                ? 'Taken off the rider and reassigned.'
                : 'Taken off the rider, but no other rider is available right now.',
            reassigned: !!result?.success
        });
    } catch (error) {
        logger.error('ReassignDelivery Error:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
