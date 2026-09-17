import mongoose from 'mongoose';

/* ----------------------------------
   STATUS CONSTANTS
----------------------------------- */
const BUSINESS_STATUSES = [
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'waiting_for_rider',
    'cancelled'
];

const LOGISTICS_STATUSES = [
    'assigned',
    'out-for-delivery',
    'in_transit',
    'delivered'
];

const TERMINAL_STATUSES = ['delivered', 'cancelled'];

const ALL_STATUSES = [...BUSINESS_STATUSES, ...LOGISTICS_STATUSES];


/* ----------------------------------
   ORDER SCHEMA
----------------------------------- */
const orderSchema = new mongoose.Schema(
    {
        orderNumber: {
            type: String,
            unique: true
        },

        brand: {
            type: String,
            enum: ['teasntrees', 'littleh'],
            default: 'teasntrees',
            required: true
        },

        // Set by the rider-assignment escalation monitor so the same stuck
        // order is not re-escalated every minute.
        escalatedAt: {
            type: Date,
            default: null
        },

        outletId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Outlet'
            // To be made required after migration
        },

        pickupLocation: {
            type: {
                type: String,
                enum: ['Point']
                // No default: 'Point' to avoid invalid GeoJSON with missing coordinates
            },
            coordinates: [Number] // [lng, lat]
        },

        customerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },

        items: [{
            product: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Product'
            },
            name: String,
            // Floored at 1. createOrder builds items straight from the request
            // body (it never reads the server-side Cart, whose own `min: 1`
            // therefore protects nothing), and a negative or fractional quantity
            // drags subtotal -> tax -> total to zero or below. Last line of
            // defence if another code path ever writes an order.
            quantity: { type: Number, required: true, min: 1 },
            price: Number,
            finalPrice: Number,
            weight: Number,
            isCustomized: {
                type: Boolean,
                default: false
            },
            isEggless: {
                type: Boolean,
                default: false
            },
            customization: String,
            customizationDetails: {
                cakeMessage: String,
                colorTheme: String,
                designDescription: String,
                referenceImage: String
            },
            selectedVariants: [
                {
                    name: String,
                    price: Number
                }
            ]
        }],

        subtotal: Number,
        deliveryCharge: Number,
        tax: Number,
        couponCode: { type: String, default: null },
        discount: { type: Number, default: 0 },

        // Stamped on every order created by one checkout (a multi-brand cart
        // makes several). Lets a retried checkout return the SAME orders instead
        // of creating duplicates. See utils/idempotency.js.
        idempotencyKey: { type: String, default: null, index: true },

        total: {
            type: Number,
            required: true,
            // An order can never be worth less than nothing. Belt and braces
            // against any future arithmetic that could go negative.
            min: 0
        },

        deliveryAddress: {
            address: String,
            location: {
                type: {
                    type: String,
                    enum: ['Point']
                },
                coordinates: [Number] // [lng, lat]
            }
        },

        riderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },

        handledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },

        riderEarning: Number,

        status: {
            type: String,
            enum: ALL_STATUSES,
            default: 'pending'
        },

        paymentMethod: {
            type: String,
            enum: ['COD', 'Online'],
            required: true
        },

        paymentStatus: {
            type: String,
            enum: ['pending', 'paid', 'refunded'],
            default: 'pending'
        },

        razorpayOrderId: { type: String, default: null },
        razorpayPaymentId: { type: String, default: null },
        razorpaySignature: { type: String, default: null },

        foodRating: { type: Number, min: 1, max: 5 },
        riderRating: { type: Number, min: 1, max: 5 },

        review: String,
        specialInstructions: String,

        // An optional second number to reach for THIS delivery — e.g. ordering
        // to a parent's house, or a building gate. Distinct from the account
        // mobile; the rider gets it alongside the primary.
        alternatePhone: { type: String, default: null },

        estimatedDeliveryTime: Date,

        confirmedAt: Date,
        assignedAt: Date,
        outForDeliveryAt: Date,
        deliveredAt: Date,
        cancelledAt: Date,

        cancelReason: String,

        timeline: [{
            status: String,
            timestamp: { type: Date, default: Date.now },
            description: String
        }]
    },
    {
        timestamps: true
    });

/* ----------------------------------
   INDEXES
----------------------------------- */
orderSchema.index({ riderId: 1 });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ brand: 1, createdAt: -1 });
orderSchema.index({ 'deliveryAddress.location': '2dsphere' });
orderSchema.index({ pickupLocation: '2dsphere' });
orderSchema.index({ customerId: 1 });
orderSchema.index({ customerId: 1, status: 1 });

/* ----------------------------------
   ORDER NUMBER GENERATION
----------------------------------- */
orderSchema.pre('save', async function () {
    if (this.orderNumber) return;

    const Counter = mongoose.model('Counter');

    const counter = await Counter.findOneAndUpdate(
        { name: 'order' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );

    this.orderNumber = `ORD${String(counter.seq).padStart(6, '0')}`;
});

/* ----------------------------------
   TERMINAL STATUS PROTECTION
----------------------------------- */
orderSchema.pre('save', async function () {
    if (!this.isModified('status')) return;
    if (this.isNew) return;

    const previous = await this.constructor
        .findById(this._id)
        .select('status')
        .lean();

    if (
        previous &&
        TERMINAL_STATUSES.includes(previous.status) &&
        previous.status !== this.status
    ) {
        throw new Error('Cannot change status after terminal state');
    }
});

/* ----------------------------------
   LOGISTICS STATUS GUARD
   Only Delivery model is allowed to set
   logistics statuses. This prevents
   conflicting writes from controllers.
----------------------------------- */
orderSchema.pre('save', async function () {
    if (!this.isModified('status')) return;

    if (
        LOGISTICS_STATUSES.includes(this.status) &&
        !this.$locals?.allowDeliverySync
    ) {
        throw new Error('Logistics status can only be updated by Delivery sync');
    }
});


/* ----------------------------------
   EXPORT
----------------------------------- */
export default mongoose.model('Order', orderSchema);
