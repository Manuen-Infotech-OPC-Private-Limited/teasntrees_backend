import mongoose from 'mongoose';

/**
 * A rider-reported issue — a bike breakdown, a customer refusing delivery, an
 * app problem, a payment dispute. Testers asked for a way to flag trouble from
 * the road; this gives admins a queue to work rather than a phone call with no
 * record.
 */
const riderReportSchema = new mongoose.Schema(
    {
        riderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        // Optional: the delivery the issue is about.
        deliveryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Delivery',
            default: null
        },
        category: {
            type: String,
            enum: [
                'delivery',
                'customer',
                'payment',
                'vehicle',
                'app',
                'other'
            ],
            default: 'other'
        },
        message: { type: String, required: true, trim: true, maxlength: 2000 },
        status: {
            type: String,
            enum: ['open', 'in_progress', 'resolved'],
            default: 'open',
            index: true
        }
    },
    { timestamps: true }
);

export default mongoose.model('RiderReport', riderReportSchema);
