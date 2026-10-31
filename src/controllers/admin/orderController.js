import Order from "../../models/Order.js";
import User from "../../models/User.js";
import Settings from "../../models/Settings.js";
import Delivery from "../../models/Delivery.js";

import { SOCKET_EVENTS, SOCKET_ROOMS } from "../../sockets/socketEvents.js";
import activityLogService from "../../services/activityLogService.js";
import { riderAssignmentService } from "../../services/riderAssignmentService.js";
import { getDistance } from "../../utils/geoUtils.js";

/* =========================================================
   GET ALL ORDERS
========================================================= */
export const getAllOrders = async (req, res) => {
    try {
        const { status, customerId, startDate, endDate, search } = req.query;
        const brand = req.activeBrand;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const query = {};
        if (status) query.status = status;
        // "Needs attention": orders the stale-order job has flagged and that are
        // still open (services/staleOrderService.js cancels them 24h later).
        if (req.query.stale === 'true') {
            query.staleFlaggedAt = { $ne: null };
            query.status = { $nin: ['delivered', 'cancelled'] };
        }
        if (customerId) query.customerId = customerId;
        if (brand) query.brand = brand;

        if (search) {
            const s = search.trim();
            const matchingUsers = await User.find({
                $or: [
                    { name: { $regex: s, $options: 'i' } },
                    { mobile: { $regex: s, $options: 'i' } }
                ]
            }).select('_id');
            const userIds = matchingUsers.map(u => u._id);

            query.$or = [
                { orderNumber: { $regex: s, $options: 'i' } },
                { customerId: { $in: userIds } },
                { 'deliveryAddress.name': { $regex: s, $options: 'i' } },
                { 'deliveryAddress.phone': { $regex: s, $options: 'i' } }
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

        const orders = await Order.find(query)
            .populate('customerId', 'name mobile email')
            .populate('riderId', 'name mobile')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Order.countDocuments(query);

        res.json({
            success: true,
            data: orders,
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

/* =========================================================
   GET SINGLE ORDER
========================================================= */
export const getOrderById = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id)
            .populate('customerId', 'name mobile email address')
            .populate('riderId', 'name mobile');

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/* =========================================================
   UPDATE ORDER STATUS (ADMIN – BUSINESS ONLY)
========================================================= */
export const updateOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, cancelReason } = req.body;

        const allowedStatuses = ['confirmed', 'preparing', 'ready', 'cancelled'];
        if (!allowedStatuses.includes(status)) {
            return res.status(403).json({
                success: false,
                message: `Admin cannot set status to '${status}'`
            });
        }

        const order = await Order.findById(id);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const transitions = {
            pending: ['confirmed', 'cancelled'],
            confirmed: ['preparing', 'cancelled'],
            preparing: ['ready', 'cancelled'],
            ready: ['cancelled'],
            waiting_for_rider: ['cancelled'],
            assigned: ['cancelled'],
            'out-for-delivery': ['cancelled'],
            in_transit: ['cancelled']
        };

        if (!transitions[order.status]?.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid transition from '${order.status}' to '${status}'`
            });
        }

        // Business status update (admin only)
        let finalStatus = status;
        if (status === 'ready') {
            // If rider already accepted, show assigned; else waiting_for_rider
            const delivery = await Delivery.findOne({ orderId: order._id }).select('status');
            if (delivery && ['accepted', 'heading_to_pickup', 'arrived_at_pickup'].includes(delivery.status)) {
                finalStatus = 'assigned';
                // Allow system-side logistics update
                order.$locals.allowDeliverySync = true;
            } else {
                finalStatus = 'waiting_for_rider';
            }
        }

        const previousStatus = order.status;
        order.status = finalStatus;

        if (status === 'confirmed') {
            order.confirmedAt = new Date();
        }

        if (status === 'cancelled') {
            order.cancelledAt = new Date();
            order.cancelReason = cancelReason || 'Cancelled by admin';
        }

        await order.save();

        // Auto-assign only AFTER confirming.
        // Confirmed should advance to preparing automatically.
        if (status === 'confirmed') {
            order.status = 'preparing';
            await order.save();

            const coords = order.deliveryAddress?.location?.coordinates;
            if (coords && coords.length === 2) {
                const BRAND_OUTLETS = {
                    littleh: { lat: 16.3090654, lng: 80.4309655, name: 'Cream N Crust (Amaravathi Road)' },
                    teasntrees: { lat: 16.314207, lng: 80.4187407, name: 'Teas N Trees (Lakshmipuram)' }
                };
                const OUTLET = BRAND_OUTLETS[order.brand] || BRAND_OUTLETS.teasntrees;

                const distance = getDistance(
                    OUTLET.lat,
                    OUTLET.lng,
                    coords[1],
                    coords[0]
                );

                const settings = (await Settings.findOne({ brand: order.brand })) || {};
                const base = settings.riderBaseEarning || 20;
                const rate = settings.distanceBonusPerKm || 5;

                await riderAssignmentService.assignRiderWithRetry(
                    order,
                    req.app.get('io'),
                    {
                        orderId: order._id,
                        brand: order.brand,
                        customerId: order.customerId,
                        pickupLocation: (order.pickupLocation && order.pickupLocation.coordinates && order.pickupLocation.coordinates.length === 2)
                            ? order.pickupLocation
                            : {
                                type: 'Point',
                                coordinates: [OUTLET.lng, OUTLET.lat],
                                address: OUTLET.name
                            },
                        deliveryLocation: order.deliveryAddress.location,
                        distance,
                        baseEarning: base,
                        totalEarning: Math.round(base + (distance / 1000) * rate),
                        pickupOtp: Math.floor(1000 + Math.random() * 9000).toString(),
                        deliveryOtp: Math.floor(1000 + Math.random() * 9000).toString()
                    }
                );
            }
        }

        // Status already adjusted to waiting_for_rider above when ready
        if (order.status === 'waiting_for_rider') {
            riderAssignmentService.processWaitingOrders(req.app.get('io'));
        }

        // Re-fetch to return latest state (Delivery hook may have updated it)
        const updatedOrder = await Order.findById(order._id);

        // Socket events
        const io = req.app.get('io');
        if (io) {
            io.to(SOCKET_ROOMS.user(order.customerId.toString()))
                .emit(SOCKET_EVENTS.ORDER_STATUS_UPDATED, {
                    orderId: updatedOrder._id,
                    status: updatedOrder.status
                });

            io.to(SOCKET_ROOMS.role('admin'))
                .to(SOCKET_ROOMS.role('manager'))
                .emit(SOCKET_EVENTS.ORDER_STATUS_UPDATED, {
                    orderId: updatedOrder._id,
                    status: updatedOrder.status
                });
        }

        await activityLogService.log(req, {
            action: 'update_status',
            resource: 'order',
            resourceId: updatedOrder._id,
            details: { previousStatus, newStatus: updatedOrder.status }
        });

        return res.json({
            success: true,
            message: 'Order status updated successfully',
            data: updatedOrder
        });

    } catch (error) {
        console.error('[updateOrderStatus ERROR]', error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/* =========================================================
   UPDATE PAYMENT STATUS (ADMIN – CONTROLLED)
========================================================= */
export const updatePaymentStatus = async (req, res) => {
    try {
        const { paymentStatus } = req.body;
        const allowed = ['pending', 'paid', 'refunded'];

        if (!allowed.includes(paymentStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment status'
            });
        }

        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { paymentStatus },
            { new: true }
        );

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const io = req.app.get('io');
        if (io && order.customerId) {
            io.to(SOCKET_ROOMS.user(order.customerId.toString()))
                .emit('payment:status-updated', {
                    orderId: order._id,
                    paymentStatus
                });
        }

        res.json({
            success: true,
            message: 'Payment status updated',
            data: order
        });

        // Log Activity
        await activityLogService.log(req, {
            action: 'update_status',
            resource: 'order',
            resourceId: order._id,
            details: { type: 'payment', paymentStatus }
        });

    } catch (error) {
        console.error('[updatePaymentStatus ERROR]:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};


/* =========================================================
   MANUAL RIDER ASSIGNMENT
========================================================= */
export const assignDeliveryRider = async (req, res) => {
    try {
        const { id } = req.params;
        const { riderId } = req.body;

        const order = await Order.findById(id);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const rider = await User.findOne({ _id: riderId, role: 'rider' });
        if (!rider) {
            return res.status(404).json({ success: false, message: 'Rider not found' });
        }

        const delivery = await riderAssignmentService.createOrUpdateDelivery(order, rider);

        order.status = 'assigned';
        order.riderId = rider._id;
        await order.save();

        res.json({
            success: true,
            message: 'Rider assigned successfully',
            data: { order, delivery }
        });

        // Socket events
        const io = req.app.get('io');
        if (io) {
            io.to(SOCKET_ROOMS.user(order.customerId.toString()))
                .emit(SOCKET_EVENTS.ORDER_STATUS_UPDATED, {
                    orderId: order._id,
                    status: 'assigned'
                });
        }

        // Log Activity
        await activityLogService.log(req, {
            action: 'assign_rider',
            resource: 'order',
            resourceId: order._id,
            details: { riderId: rider._id }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};


/* =========================================================
   CANCEL ORDER
========================================================= */
export const cancelOrder = async (req, res) => {
    try {
        const { reason } = req.body;
        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        if (order.status === 'delivered') {
            return res.status(400).json({ success: false, message: 'Cannot cancel delivered order' });
        }

        order.status = 'cancelled';
        order.cancelReason = reason || 'Cancelled by admin';
        order.cancelledAt = new Date();
        await order.save();

        res.json({
            success: true,
            message: 'Order cancelled successfully',
            data: order
        });

        // Log Activity
        await activityLogService.log(req, {
            action: 'cancel',
            resource: 'order',
            resourceId: order._id,
            details: { reason: order.cancelReason }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/* =========================================================
   ORDER STATS
========================================================= */
export const getOrderStats = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const queryBase = {};
        if (req.activeBrand) queryBase.brand = req.activeBrand;

        const [
            totalOrders,
            pendingOrders,
            deliveredOrders,
            cancelledOrders,
            inProgressOrders,
            revenueData
        ] = await Promise.all([
            Order.countDocuments(queryBase),
            Order.countDocuments({ ...queryBase, status: 'pending' }),
            Order.countDocuments({ ...queryBase, status: 'delivered' }),
            Order.countDocuments({ ...queryBase, status: 'cancelled' }),
            Order.countDocuments({
                ...queryBase,
                status: {
                    $in: [
                        'confirmed',
                        'preparing',
                        'ready',
                        'waiting_for_rider',
                        'assigned',
                        'out-for-delivery',
                        'in_transit'
                    ]
                }
            }),
            Order.aggregate([
                {
                    $match: {
                        ...queryBase,
                        status: 'delivered',
                        paymentStatus: 'paid',
                        deliveredAt: { $gte: today }
                    }
                },
                { $group: { _id: null, total: { $sum: '$total' } } }
            ])
        ]);

        res.json({
            success: true,
            data: {
                totalOrders,
                pendingOrders,
                deliveredOrders,
                cancelledOrders,
                inProgressOrders,
                todayRevenue: revenueData.length > 0 ? revenueData[0].total : 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
