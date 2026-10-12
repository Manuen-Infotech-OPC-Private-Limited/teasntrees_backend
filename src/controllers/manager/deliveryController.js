import Delivery from '../../models/Delivery.js';

/* =========================================================
   GET DELIVERIES (MANAGER DASHBOARD)
========================================================= */
export const getDeliveries = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 1000,
            type // 'active' or undefined for all
        } = req.query;

        const brand = req.activeBrand || req.params.brand || 'littleh';
        const skip = (Number(page) - 1) * Number(limit);

        const query = { brand };

        // If 'active' type requested, filter by specific active statuses
        if (type === 'active') {
            const activeStatuses = [
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
            ];
            query.status = { $in: activeStatuses };
        }

        const deliveries = await Delivery.find(query)
            .populate('riderId', 'name mobile currentLocation isOnline')
            .populate('orderId', 'orderNumber total deliveryAddress')
            .populate('customerId', 'name mobile')
            .sort({ updatedAt: -1 })
            .skip(skip)
            .limit(Number(limit));

        const total = await Delivery.countDocuments(query);

        // Shape data for dashboard / map - Keys must match frontend (riderId, orderId, customerId)
        const data = deliveries.map(d => ({
            _id: d._id,
            deliveryNumber: d.deliveryNumber,
            status: d.status,
            updatedAt: d.updatedAt,

            riderId: d.riderId ? {
                _id: d.riderId._id,
                name: d.riderId.name,
                mobile: d.riderId.mobile,
                isOnline: d.riderId.isOnline,
                currentLocation: d.riderId.currentLocation || null
            } : null,

            orderId: d.orderId ? {
                _id: d.orderId._id,
                orderNumber: d.orderId.orderNumber,
                total: d.orderId.total
            } : null,

            customerId: d.customerId ? {
                _id: d.customerId._id,
                name: d.customerId.name,
                mobile: d.customerId.mobile
            } : null,

            pickupLocation: d.pickupLocation?.address ? d.pickupLocation : {
                ...d.pickupLocation,
                address: d.brand === 'littleh' ? 'Cream N Crust (Amaravathi Road)' : 'Teas N Trees (Lakshmipuram)'
            },
            deliveryLocation: d.deliveryLocation?.address ? d.deliveryLocation : {
                ...d.deliveryLocation,
                address: d.orderId?.deliveryAddress?.address || 'Customer Address'
            },
            estimatedTime: d.estimatedTime
        }));

        res.status(200).json({
            success: true,
            data,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                totalPages: Math.ceil(total / Number(limit))
            }
        });

    } catch (error) {
        console.error('Error fetching deliveries:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching deliveries'
        });
    }
};
