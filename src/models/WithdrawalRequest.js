import mongoose from 'mongoose';

/**
 * A rider's request to be paid out their available (delivered-but-unpaid)
 * earnings. Admins already had `processPayout`, but the rider had no way to
 * ASK for it — testers wanted a "Withdraw" action. This is that request; an
 * admin still reviews and pays it, so no money moves automatically.
 */
const withdrawalRequestSchema = new mongoose.Schema(
    {
        riderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        // The available balance at the time of the request, in rupees.
        amount: { type: Number, required: true, min: 1 },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected', 'paid'],
            default: 'pending',
            index: true
        },
        // Set when an admin settles it.
        processedAt: { type: Date, default: null },
        payoutReference: { type: String, default: null },
        note: { type: String, default: null }
    },
    { timestamps: true }
);

// A rider should not stack multiple open requests. Enforced in the controller;
// this index makes the lookup cheap.
withdrawalRequestSchema.index({ riderId: 1, status: 1 });

export default mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
