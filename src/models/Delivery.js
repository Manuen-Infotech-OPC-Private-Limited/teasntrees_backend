import mongoose from 'mongoose';
import Counter from './Counter.js';
import './Order.js';
import './User.js';
import Rider from './Rider.js';
import { riderAssignmentService } from '../services/riderAssignmentService.js';
import { notificationService } from '../services/notificationService.js';

/* ----------------------------------
   DELIVERY → ORDER STATUS MAP
----------------------------------- */
const DELIVERY_TO_ORDER_STATUS = {
    // "pending_acceptance" here means offer sent; do not mark order assigned yet
    pending_acceptance: null,
    // After acceptance/movement, mark order as assigned
    accepted: 'assigned',
    heading_to_pickup: 'assigned',
    arrived_at_pickup: 'assigned',
    picked_up: 'out-for-delivery',
    in_transit: 'in_transit',
    arrived: 'in_transit',
    delivered: 'delivered',
    rejected: 'waiting_for_rider',
    cancelled: 'cancelled'
};

/* ----------------------------------
   DELIVERY SCHEMA
----------------------------------- */
const deliverySchema = new mongoose.Schema({
    deliveryNumber: { type: String, unique: true },

    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true
    },

    brand: {
        type: String,
        enum: ['teasntrees', 'littleh'],
        default: 'teasntrees',
        required: true,
        index: true
    },

    riderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rider',
        required: true
    },

    customerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    customerName: String,
    customerMobile: String,
    // Denormalized alongside name/mobile so the rider app can show the customer
    // on the map without a second round-trip. Null when the customer signed up
    // with a mobile number rather than Google (most of them) — the app falls
    // back to their initials, it must never invent a face.
    customerImage: { type: String, default: null },
    // Optional second number the customer gave for this delivery.
    customerAltPhone: { type: String, default: null },
    deliveryAddress: String, // Plain text address

    pickupLocation: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: [Number],
        address: String
    },

    deliveryLocation: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: [Number],
        address: String
    },

    distance: { type: Number, required: true },
    estimatedTime: Number,

    status: {
        type: String,
        enum: [
            'pending_acceptance',
            'accepted',
            'rejected',
            'heading_to_pickup',
            'arrived_at_pickup',
            'picked_up',
            'in_transit',
            'arrived',
            'delivered',
            'cancelled'
        ],
        default: 'pending_acceptance'
    },

    assignedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    rejectedAt: Date,
    pickedUpAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,

    pickupOtp: String,
    deliveryOtp: String,

    baseEarning: { type: Number, required: true },
    distanceBonus: { type: Number, default: 0 },
    surgeBonus: { type: Number, default: 0 },
    tipAmount: { type: Number, default: 0 },
    totalEarning: { type: Number, required: true },

    isPaid: { type: Boolean, default: false },
    paidAt: Date,
    payoutReference: String, // Transaction ID/UTR

    rating: { type: Number, min: 1, max: 5 },
    feedback: String,
    notes: String,
    cancelReason: String,
    rejectionReason: String,
    deliveryProof: String,

    // COD Payment Handling
    paymentMode: { type: String, enum: ['cash', 'upi', 'none'], default: 'none' },
    paymentStatus: { type: String, enum: ['pending', 'collected', 'handed_over'], default: 'pending' },
    amountCollected: { type: Number, default: 0 },

    /* ----------------------------------
       STALL WATCHDOG

       Once a rider accepted, nothing watched them ever again: the escalation
       monitor only looks at orders still in `waiting_for_rider`, and an accepted
       order has left that status. A rider who accepted and then went home left
       the order frozen forever, with the customer watching a stationary bike and
       nobody alerted. These fields let deliveryWatchdogService tell "stuck in
       traffic" apart from "not coming".
    ----------------------------------- */

    // How far the rider was from the current stop when they last made real
    // progress toward it, and when that was.
    lastProgressDistance: { type: Number, default: null }, // metres
    lastProgressAt: { type: Date, default: null },

    // Set when we nudge the rider / escalate to admins, so we do it once per
    // stall rather than every time the monitor ticks. Cleared as soon as the
    // rider starts moving again.
    stallNudgedAt: { type: Date, default: null },
    stallEscalatedAt: { type: Date, default: null }
}, {
    timestamps: true
});

/* ----------------------------------
   INDEXES
----------------------------------- */
deliverySchema.index({ orderId: 1 });
deliverySchema.index({ riderId: 1, status: 1 });
deliverySchema.index({ customerId: 1, createdAt: -1 }); // Fast delivery history
deliverySchema.index({ createdAt: -1 });
deliverySchema.index({ pickupLocation: '2dsphere' });
deliverySchema.index({ deliveryLocation: '2dsphere' });

/* ----------------------------------
   AUTO-POPULATE DENORMALIZED FIELDS
----------------------------------- */
deliverySchema.pre('save', async function () {
    try {
        if (!this.customerName || !this.deliveryAddress) {
            const Order = mongoose.model('Order');
            const order = await Order.findById(this.orderId).populate('customerId');
            
            if (order) {
                if (!this.customerName) this.customerName = order.customerId?.name || 'Customer';
                if (!this.customerMobile) this.customerMobile = order.customerId?.mobile || '';
                if (!this.customerImage) this.customerImage = order.customerId?.profileImage || null;
                if (!this.customerAltPhone) this.customerAltPhone = order.alternatePhone || null;
                if (!this.deliveryAddress) this.deliveryAddress = order.deliveryAddress?.address || 'Customer Address';
                if (!this.brand) this.brand = order.brand;
            }
        }
    } catch (err) {
        console.error('Delivery pre-save error:', err);
        // Throwing error allows Mongoose to handle it properly
        throw err;
    }
});

/* ----------------------------------
   DELIVERY NUMBER
----------------------------------- */
deliverySchema.pre('save', async function () {
    if (this.deliveryNumber) return;

    const Counter = mongoose.model('Counter');
    const counter = await Counter.findOneAndUpdate(
        { name: 'delivery' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
    );

    this.deliveryNumber = `DEL${String(counter.seq).padStart(6, '0')}`;
});

/* ----------------------------------
   STATUS CHANGE DETECTION
----------------------------------- */
deliverySchema.pre('save', function () {
    this._statusChanged = this.isModified('status');
    this._riderChanged = this.isModified('riderId');
});

/* ----------------------------------
   HELPER: RELEASE RIDER
----------------------------------- */
const releaseRider = async (riderId) => {
    if (!riderId) return;
    try {
        await Rider.findByIdAndUpdate(riderId, { isOnDelivery: false });
        riderAssignmentService.emitRiderStatus(riderId, { isOnDelivery: false, isBusy: false });
    } catch (error) {
        console.error(`Failed to release rider ${riderId}:`, error);
    }
};

const markRiderBusy = async (riderId) => {
    if (!riderId) return;
    try {
        await Rider.findByIdAndUpdate(riderId, { isOnDelivery: true });
        riderAssignmentService.emitRiderStatus(riderId, { isOnDelivery: true, isBusy: true });
    } catch (error) {
        console.error(`Failed to mark rider busy ${riderId}:`, error);
    }
};

/* ----------------------------------
   ORDER STATUS SYNC (SAFE)
----------------------------------- */
deliverySchema.post('save', async function (delivery) {
    if (!delivery._statusChanged && !delivery._riderChanged) {
        // Fallback: If status is delivered, ensure rider is released anyway
        if (delivery.status === 'delivered') {
            await releaseRider(delivery.riderId);
        }
        return;
    }

    const ACTIVE_RIDER_STATUSES = new Set([
        'heading_to_pickup',
        'arrived_at_pickup',
        'picked_up',
        'in_transit',
        'arrived'
    ]);

    if (ACTIVE_RIDER_STATUSES.has(delivery.status)) {
        await markRiderBusy(delivery.riderId);
    }

    const Order = mongoose.model('Order');
    const order = await Order.findById(delivery.orderId);

    if (!order) return;
    if (['delivered', 'cancelled'].includes(order.status)) return;

    let mutated = false;

    // Self-healing: Repair invalid/missing data in order and delivery
    if (order.pickupLocation && (!order.pickupLocation.coordinates || order.pickupLocation.coordinates.length !== 2)) {
        order.pickupLocation = delivery.pickupLocation;
        mutated = true;
    }

    // Ensure delivery has accurate address strings from order
    if (order.deliveryAddress?.address && !delivery.deliveryLocation?.address) {
        delivery.deliveryLocation = {
            ...delivery.deliveryLocation,
            address: order.deliveryAddress.address
        };
    }


    // Sync rider if changed
    if (delivery._riderChanged) {
        if (
            !order.riderId ||
            order.riderId.toString() !== delivery.riderId.toString()
        ) {
            order.riderId = delivery.riderId;
            mutated = true;
        }
    }

    const mappedStatus = DELIVERY_TO_ORDER_STATUS[delivery.status];

    if (mappedStatus && order.status !== mappedStatus) {
        if (mappedStatus === 'assigned' && !['ready', 'waiting_for_rider', 'assigned'].includes(order.status)) {
            return;
        }
        order.status = mappedStatus;
        mutated = true;

        if (mappedStatus === 'assigned' && !order.assignedAt) {
            order.assignedAt = new Date();
        }

        if (mappedStatus === 'out-for-delivery') {
            order.outForDeliveryAt = new Date();
        }

        if (mappedStatus === 'delivered') {
            order.deliveredAt = new Date();
        }

        if (mappedStatus === 'waiting_for_rider') {
            // If the rider rejected/cancelled, clear riderId
            if (
                order.riderId &&
                delivery.riderId &&
                order.riderId.toString() === delivery.riderId.toString()
            ) {
                // ONLY clear if rejected or cancelled
                if (['rejected', 'cancelled'].includes(delivery.status)) {
                    order.riderId = undefined;
                    await releaseRider(delivery.riderId);
                }
            }
        }

        order.timeline.push({
            status: mappedStatus,
            description: `Updated via delivery (${delivery.status})`,
            timestamp: new Date()
        });
    }

    // ALWAYS release rider if status is terminal
    if (['delivered', 'cancelled', 'rejected'].includes(delivery.status)) {
        await releaseRider(delivery.riderId);
    }

    if (!mutated) {
        // Even if no order status mutated, send notification for delivery updates
        sendCustomerStatusPushNotification(delivery);
        return;
    }

    // Allow logistics status updates only from Delivery sync
    order.$locals.allowDeliverySync = true;

    await order.save();
    sendCustomerStatusPushNotification(delivery);
});

/* ----------------------------------
   ATOMIC UPDATE HOOKS
----------------------------------- */
deliverySchema.post('findOneAndUpdate', async function (delivery) {
    if (!delivery) return;

    // For findOneAndUpdate, we always sync if the status is present or if it's a terminal state
    const Order = mongoose.model('Order');
    const order = await Order.findById(delivery.orderId);

    if (order && !['delivered', 'cancelled'].includes(order.status)) {
        const mappedStatus = DELIVERY_TO_ORDER_STATUS[delivery.status];
        if (mappedStatus && order.status !== mappedStatus) {
            order.status = mappedStatus;
            order.timeline.push({
                status: mappedStatus,
                description: `Updated via atomic delivery sync (${delivery.status})`,
                timestamp: new Date()
            });

            // Self-healing
            if (order.pickupLocation && (!order.pickupLocation.coordinates || order.pickupLocation.coordinates.length !== 2)) {
                order.pickupLocation = delivery.pickupLocation;
            }

            // Sync address strings to delivery if missing
            if (order.deliveryAddress?.address && !delivery.deliveryLocation?.address) {
                await mongoose.model('Delivery').findByIdAndUpdate(delivery._id, {
                    'deliveryLocation.address': order.deliveryAddress.address
                });
            }

            if (order.brand && !delivery.pickupLocation?.address) {
                await mongoose.model('Delivery').findByIdAndUpdate(delivery._id, {
                    'pickupLocation.address': order.brand === 'littleh' ? 'LittleH Outlet' : 'Teas N Trees Outlet'
                });
            }

            order.$locals.allowDeliverySync = true;
            await order.save();
        }
    }

    // Release rider if status is terminal
    if (['delivered', 'cancelled', 'rejected'].includes(delivery.status)) {
        await releaseRider(delivery.riderId);
    }

    // ONLY send notification if the status was part of the update
    const update = this.getUpdate();
    const isStatusUpdate = update.status || (update.$set && update.$set.status);
    
    if (isStatusUpdate) {
        sendCustomerStatusPushNotification(delivery);
    }
});

/* ----------------------------------
   REAL-TIME PUSH NOTIFICATIONS
----------------------------------- */
const sendCustomerStatusPushNotification = async (delivery) => {
    try {
        if (!delivery) return;
        const User = mongoose.model('User');
        const customer = await User.findById(delivery.customerId);
        if (!customer || !customer.fcmToken) return;

        const rider = await User.findById(delivery.riderId);
        const riderName = rider ? rider.name : 'A rider';

        let title = 'Order Update';
        let body = '';

        switch (delivery.status) {
            case 'accepted':
                title = 'Rider Assigned';
                body = `${riderName} has been assigned to deliver your order!`;
                break;
            case 'heading_to_pickup':
                title = 'Rider Heading to Cafe';
                body = `${riderName} is heading to the outlet to collect your order.`;
                break;
            case 'arrived_at_pickup':
                title = 'Rider Arrived at Cafe';
                body = `${riderName} has arrived at the outlet and is preparing to collect your order.`;
                break;
            case 'picked_up':
                title = 'Order Out for Delivery';
                body = `${riderName} has picked up your order and is on the way!`;
                break;
            case 'in_transit':
                title = 'Order In Transit';
                body = `${riderName} is on the way to your location.`;
                break;
            case 'arrived':
                title = 'Rider Arrived';
                body = `${riderName} has arrived at your address! Share delivery PIN ${delivery.deliveryOtp} to collect.`;
                break;
            case 'delivered':
                title = 'Order Delivered';
                body = `Your order has been successfully delivered. Thank you!`;
                break;
            case 'cancelled':
                title = 'Delivery Cancelled';
                body = `We are sorry, your delivery assignment was cancelled.`;
                break;
            default:
                return;
        }

        await notificationService.sendPush(customer, {
            title,
            body,
            data: {
                deliveryId: delivery._id.toString(),
                orderId: delivery.orderId.toString(),
                status: delivery.status
            }
        });
    } catch (err) {
        console.error('Failed to send status push notification:', err);
    }
};

/* ----------------------------------
   EXPORT
----------------------------------- */
export default mongoose.model('Delivery', deliverySchema);
