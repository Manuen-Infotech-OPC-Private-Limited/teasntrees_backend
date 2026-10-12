import mongoose from 'mongoose';
import User from '../models/User.js';
import Rider from '../models/Rider.js';
import Customer from '../models/Customer.js';
import RefreshToken from '../models/RefreshToken.js';
import { admin } from './firebaseAuth.js';
import { uploadService } from './storage/upload.service.js';
import logger from '../config/logger.js';

/**
 * In-app account deletion (an App Store and Play requirement).
 *
 * The account is deactivated and stripped of everything that identifies the
 * person; the document itself stays, so past orders and deliveries still point
 * at something and the books still add up. Order records keep the delivery
 * address they were delivered to — that is the business's record of the sale.
 *
 * Mobile and email are replaced with a unique placeholder rather than cleared:
 * both sit in unique indexes, and the placeholder can never match a sign-in, so
 * the same person can register again later and gets a clean account.
 */

export class DeletionBlockedError extends Error {}

const placeholder = (id) => `deleted-${id}`;

const endSessions = (userId, now) =>
    RefreshToken.updateMany({ user: userId, isRevoked: false }, { $set: { isRevoked: true, revokedAt: now } });

// Without this the next sign-in with the same phone or Google account would
// silently reuse the old Firebase identity. Never worth failing the deletion.
const removeFirebaseUser = async ({ mobile, email }) => {
    try {
        const auth = admin.auth();
        const found = mobile
            ? await auth.getUserByPhoneNumber(`+91${mobile}`)
            : email ? await auth.getUserByEmail(email) : null;
        if (found) await auth.deleteUser(found.uid);
    } catch (error) {
        if (error?.code !== 'auth/user-not-found') {
            logger.warn('Account deletion: could not remove the Firebase user', { error: error.message });
        }
    }
};

const removeFiles = async (urls) => {
    for (const url of urls.filter(Boolean)) {
        try {
            await uploadService.deleteFile(uploadService.extractPublicId(url));
        } catch (error) {
            logger.warn('Account deletion: could not remove a stored file', { error: error.message });
        }
    }
};

export const deleteCustomerAccount = async (userId) => {
    const customer = await User.findOne({ _id: userId, role: 'customer' });
    if (!customer) return null;

    const Order = mongoose.model('Order');
    const openOrder = await Order.exists({ customerId: userId, status: { $nin: ['delivered', 'cancelled'] } });
    if (openOrder) {
        throw new DeletionBlockedError(
            'You have an order in progress. You can delete your account once it is delivered or cancelled.'
        );
    }

    const now = new Date();
    const { mobile, email, _id } = customer;
    const profileImage = customer.get('profileImage');

    await Customer.updateOne(
        { _id },
        {
            $set: {
                name: 'Deleted user',
                mobile: placeholder(_id),
                email: `${placeholder(_id)}@deleted.invalid`,
                address: null,
                addresses: [],
                wishlist: [],
                profileImage: null,
                fcmToken: null,
                isActive: false,
                isProfileComplete: false,
                deletedAt: now
            },
            $unset: { location: '' }
        }
    );

    await endSessions(_id, now);
    await mongoose.model('Cart').deleteMany({ userId: _id });
    await removeFiles([profileImage]);
    await removeFirebaseUser({ mobile, email });

    logger.info('Customer deleted their account', { userId: _id });
    return { id: _id, name: customer.name, mobile };
};

export const deleteRiderAccount = async (riderId) => {
    const rider = await Rider.findById(riderId);
    if (!rider) return null;

    const Delivery = mongoose.model('Delivery');
    const active = await Delivery.exists({
        riderId,
        status: { $nin: ['delivered', 'cancelled', 'rejected'] }
    });
    if (active) {
        throw new DeletionBlockedError('Finish your active delivery before deleting your account.');
    }
    if ((rider.pendingEarnings || 0) > 0) {
        throw new DeletionBlockedError(
            `You still have ₹${rider.pendingEarnings} to be paid out. Withdraw it first, then delete your account.`
        );
    }

    const now = new Date();
    const { mobile, _id } = rider;
    const files = [rider.licensePhoto, rider.aadharPhoto, rider.panPhoto, rider.image];

    await Rider.updateOne(
        { _id },
        {
            $set: {
                name: 'Deleted rider',
                mobile: placeholder(_id),
                email: `${placeholder(_id)}@deleted.invalid`,
                address: null,
                image: null,
                fcmToken: null,
                verificationPin: null,
                // vehicleNumber is unique too.
                vehicleNumber: placeholder(_id),
                vehicleModel: null,
                licenseNumber: null,
                licensePhoto: null,
                aadharNumber: null,
                aadharPhoto: null,
                panNumber: null,
                panPhoto: null,
                bankAccountNumber: null,
                ifscCode: null,
                accountHolderName: null,
                emergencyContact: null,
                isOnline: false,
                isApproved: false,
                isActive: false,
                deletedAt: now
            },
            $unset: { location: '', currentLocation: '' }
        }
    );

    await endSessions(_id, now);
    await removeFiles(files);
    // Riders only have a Firebase identity if they have used the PIN reset.
    await removeFirebaseUser({ mobile });

    logger.info('Rider deleted their account', { riderId: _id });
    return { id: _id, name: rider.name, mobile, readableId: rider.readableId };
};
