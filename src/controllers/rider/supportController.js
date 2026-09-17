import mongoose from 'mongoose';
import RiderReport from '../../models/RiderReport.js';
import WithdrawalRequest from '../../models/WithdrawalRequest.js';
import Delivery from '../../models/Delivery.js';
import User from '../../models/User.js';
import logger from '../../config/logger.js';
import { notificationService } from '../../services/notificationService.js';

/* ======================================================
   REPORT AN ISSUE  (POST /rider/support/report)
====================================================== */
export const reportIssue = async (req, res) => {
    try {
        const riderId = req.user.userId;
        const { category, message, deliveryId } = req.body;

        const text = (message ?? '').toString().trim();
        if (!text) {
            return res.status(400).json({
                success: false,
                message: 'Please describe the issue.'
            });
        }

        const allowed = ['delivery', 'customer', 'payment', 'vehicle', 'app', 'other'];
        const cat = allowed.includes(category) ? category : 'other';

        const report = await RiderReport.create({
            riderId,
            category: cat,
            message: text,
            deliveryId:
                deliveryId && mongoose.isValidObjectId(deliveryId)
                    ? deliveryId
                    : null
        });

        // Let staff know there's something to look at.
        try {
            const rider = await User.findById(riderId).select('name');
            await notificationService.notifyAdmins(User, {
                title: '🚨 Rider reported an issue',
                body: `${rider?.name || 'A rider'} (${cat}): ${text.slice(0, 80)}`,
                data: { type: 'rider_report', reportId: report._id.toString() }
            });
            req.app.get('io')?.to('role:admin').to('role:manager').emit('rider:report', {
                reportId: report._id.toString(),
                riderId,
                category: cat
            });
        } catch (notifyErr) {
            logger.error('reportIssue notify failed', { error: notifyErr.message });
        }

        return res.status(201).json({
            success: true,
            message: "Thanks — we've got your report and will look into it."
        });
    } catch (error) {
        logger.error('reportIssue error', error);
        return res.status(500).json({ success: false, message: 'Could not submit your report.' });
    }
};

/* ======================================================
   AVAILABLE BALANCE  (GET /rider/earnings/balance)

   Delivered deliveries that have not yet been paid out. Same basis the admin
   payout uses, so the number the rider sees matches what an admin would settle.
====================================================== */
const availableBalance = async (riderId) => {
    const [row] = await Delivery.aggregate([
        {
            $match: {
                riderId: new mongoose.Types.ObjectId(String(riderId)),
                status: 'delivered',
                isPaid: false
            }
        },
        { $group: { _id: null, amount: { $sum: '$totalEarning' }, count: { $sum: 1 } } }
    ]);
    return {
        amount: Math.round((row?.amount || 0) * 100) / 100,
        count: row?.count || 0
    };
};

export const getBalance = async (req, res) => {
    try {
        const riderId = req.user.userId;
        const balance = await availableBalance(riderId);

        const pending = await WithdrawalRequest.findOne({
            riderId,
            status: 'pending'
        }).lean();

        return res.json({
            success: true,
            data: {
                available: balance.amount,
                deliveries: balance.count,
                pendingRequest: pending
                    ? { amount: pending.amount, requestedAt: pending.createdAt }
                    : null
            }
        });
    } catch (error) {
        logger.error('getBalance error', error);
        return res.status(500).json({ success: false, message: 'Could not load your balance.' });
    }
};

/* ======================================================
   REQUEST WITHDRAWAL  (POST /rider/earnings/withdraw)
====================================================== */
export const requestWithdrawal = async (req, res) => {
    try {
        const riderId = req.user.userId;

        // One open request at a time — otherwise a rider could file ten and an
        // admin wouldn't know which reflects the real balance.
        const existing = await WithdrawalRequest.findOne({
            riderId,
            status: 'pending'
        });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'You already have a withdrawal request being processed.'
            });
        }

        const balance = await availableBalance(riderId);
        if (balance.amount < 1) {
            return res.status(400).json({
                success: false,
                message: 'You have no earnings available to withdraw yet.'
            });
        }

        // The amount is OURS to set from the ledger, never the client's — a rider
        // must not be able to request more than they've earned.
        const request = await WithdrawalRequest.create({
            riderId,
            amount: balance.amount,
            status: 'pending'
        });

        try {
            const rider = await User.findById(riderId).select('name mobile');
            await notificationService.notifyAdmins(User, {
                title: '💸 Withdrawal requested',
                body: `${rider?.name || 'A rider'} requested ₹${balance.amount} (${balance.count} deliveries).`,
                data: { type: 'withdrawal', requestId: request._id.toString() }
            });
            req.app.get('io')?.to('role:admin').to('role:manager').emit('rider:withdrawal', {
                requestId: request._id.toString(),
                riderId,
                amount: balance.amount
            });
        } catch (notifyErr) {
            logger.error('withdrawal notify failed', { error: notifyErr.message });
        }

        return res.status(201).json({
            success: true,
            message: `Withdrawal of ₹${balance.amount} requested. We'll process it shortly.`,
            data: { amount: balance.amount }
        });
    } catch (error) {
        logger.error('requestWithdrawal error', error);
        return res.status(500).json({ success: false, message: 'Could not request the withdrawal.' });
    }
};
