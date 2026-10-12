import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import Rider from '../../models/Rider.js';
import User from '../../models/User.js';
import { riderMetricsService } from "../../services/riderMetricsService.js";
import { SOCKET_ROOMS, SOCKET_EVENTS } from "../../sockets/socketEvents.js";
import { uploadService } from '../../services/storage/upload.service.js';
import logger from '../../config/logger.js';
import { riderAssignmentService } from '../../services/riderAssignmentService.js';
import activityLogService from '../../services/activityLogService.js';
import { verifyFirebaseToken } from '../../services/firebaseAuth.js';
import { generateToken, generateRefreshToken } from '../../utils/jwtHelper.js';
import RefreshToken from '../../models/RefreshToken.js';
import { notificationService } from '../../services/notificationService.js';
import { deleteRiderAccount, DeletionBlockedError } from '../../services/accountDeletionService.js';
import fs from 'fs';
import path from 'path';

// Register a new Rider (Manual Onboarding)
export const registerRider = async (req, res) => {
    try {
        const {
            name, mobile, email,
            vehicleType, vehicleNumber, vehicleModel,
            bankAccountNumber, ifscCode, accountHolderName,
            emergencyName, emergencyPhone, emergencyRelation,
            emergencyContactName, emergencyContactMobile, emergencyContactRelation
        } = req.body;

        // Already a RIDER on this number?
        //
        // Scoped to riders deliberately: ONE PERSON MAY BE BOTH A CUSTOMER AND A
        // RIDER ON THE SAME NUMBER. Customer and Rider are separate discriminator
        // documents of User, and the unique index that governs this is the
        // compound `{ mobile, role }` — which the schema has always declared, and
        // which permits one of each per number.
        //
        // What actually forbade it was a LEGACY single-field `mobile_1` unique
        // index still sitting on the production `users` collection (Mongoose adds
        // indexes but never drops the ones you've stopped declaring). Anyone who
        // had ever shopped with us therefore blew up on `rider.save()` with a raw
        // E11000 — a 500 with the Mongo error attached. Dropped by
        // scripts/drop_legacy_user_indexes.mjs.
        const existingRider = await Rider.findOne({ mobile });
        if (existingRider) {
            return res.status(409).json({
                success: false,
                message: existingRider.isApproved
                    ? 'That number is already registered as a rider. Please sign in with your PIN.'
                    : 'That number is already registered and is waiting for approval. We will let you know as soon as it is verified.'
            });
        }


        // Check for duplicate vehicle
        const existingVehicle = await Rider.findOne({ vehicleNumber });
        if (existingVehicle) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle number already registered'
            });
        }


        const files = req.files || {};

        // Helper to upload memory buffer to Azure
        const uploadDoc = async (fileArray) => {
            if (fileArray && fileArray.length > 0) {
                const result = await uploadService.uploadPrivateFile(fileArray[0].buffer, 'rider-docs', fileArray[0].mimetype);
                return result.url;
            }
            return null;
        };

        // Accept either file uploads OR URLs from request body
        const licensePhoto = await uploadDoc(files.licensePhoto) || req.body.licensePhoto;
        const aadharPhoto = await uploadDoc(files.aadharPhoto) || req.body.aadharPhoto;
        const panPhoto = await uploadDoc(files.panPhoto) || req.body.panPhoto;
        const profilePhoto = await uploadDoc(files.profilePhoto) || req.body.profilePhoto;

        // Create Rider
        const rider = new Rider({
            name,
            mobile,
            email,
            role: 'rider',
            isApproved: false, // Pending admin approval
            isActive: true,
            isProfileComplete: true,

            // Vehicle
            vehicleType,
            vehicleNumber,
            vehicleModel,

            // Documents
            licenseNumber: req.body.licenseNumber,
            licenseExpiryDate: req.body.licenseExpiryDate,
            licensePhoto,

            aadharNumber: req.body.aadharNumber,
            aadharPhoto,

            panNumber: req.body.panNumber,
            panPhoto,

            // Profile
            image: profilePhoto,

            // Bank
            bankAccountNumber,
            ifscCode,
            accountHolderName,

            // Emergency
            emergencyContact: {
                name: emergencyName || emergencyContactName,
                mobile: emergencyPhone || emergencyContactMobile,
                relation: emergencyRelation || emergencyContactRelation
            }
        });

        // The PIN is a credential, so it is shown to the rider exactly once (in
        // this response) and only ever STORED as a bcrypt hash.
        const plainPin = String(crypto.randomInt(1000, 10000));
        rider.verificationPin = await bcrypt.hash(plainPin, 10);

        await rider.save();

        // Generate tokens for auto-login
        const token = generateToken({ userId: rider._id, role: 'rider' });
        const refreshToken = generateRefreshToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: rider._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.status(201).json({
            success: true,
            message: 'Rider registered successfully. Waiting for admin approval.',
            token,
            refreshToken,
            rider: {
                id: rider._id,
                readableId: rider.readableId,
                name: rider.name,
                mobile: rider.mobile,
                email: rider.email,
                role: 'rider',
                isApproved: rider.isApproved,
                isOnline: rider.isOnline,
                isProfileComplete: rider.isProfileComplete,
                // The only time the PIN is ever returned in the clear. It is
                // stored hashed, so this cannot be recovered later — the rider
                // must write it down (the app shows it once on this screen).
                verificationPin: plainPin,
                vehicleType: rider.vehicleType,
                vehicleNumber: rider.vehicleNumber,
                vehicleModel: rider.vehicleModel,
                bankAccountNumber: rider.bankAccountNumber,
                ifscCode: rider.ifscCode,
                accountHolderName: rider.accountHolderName
            }
        });

    } catch (error) {
        logger.error('Rider Registration Error:', error);

        // Two riders registering the same number (or vehicle) at once still race
        // past the checks above and land on the unique index. That's a 409 the
        // rider can act on, not a 500.
        if (error?.code === 11000) {
            const field = Object.keys(error.keyPattern || {})[0];
            return res.status(409).json({
                success: false,
                message:
                    field === 'vehicleNumber'
                        ? 'That vehicle number is already registered.'
                        : 'That number is already registered. Please sign in instead.'
            });
        }

        // A missing or malformed field is the rider's problem to fix, not a
        // server fault — it was answering 500, so the app could only say
        // "Registration failed" and the rider had no idea which field was wrong.
        if (error?.name === 'ValidationError') {
            const fields = Object.keys(error.errors || {});
            return res.status(400).json({
                success: false,
                message: 'Some details are missing or invalid. Please check and try again.',
                fields
            });
        }

        // The raw Mongo error used to be handed straight to the client, index
        // names and all.
        res.status(500).json({
            success: false,
            message: 'Registration failed. Please try again, or ask the store for help.'
        });
    }
};

// Complete Profile (Requires JWT)
export const completeProfile = async (req, res) => {
    try {
        const riderId = req.user.userId;
        const {
            name, email, address, location,
            vehicleType, vehicleNumber, vehicleModel,
            bankAccountNumber, ifscCode, accountHolderName,
            emergencyContactName, emergencyContactMobile, emergencyContactRelation,
            licenseNumber, licenseExpiryDate, aadharNumber, panNumber
        } = req.body;

        const rider = await Rider.findById(riderId);
        if (!rider) {
            return res.status(404).json({ success: false, message: 'Rider not found' });
        }

        const files = req.files || {};

        // Update basic info
        rider.name = name || rider.name;
        rider.email = email || rider.email;
        rider.address = address || rider.address;

        let parsedLocation = location;
        if (typeof location === 'string') {
            try {
                parsedLocation = JSON.parse(location);
            } catch (e) {
                console.error('Failed to parse location:', e);
            }
        }

        // --- Location Fallback ---
        const { geocodingService } = await import('../../services/geocodingService.js');

        let targetCoords = null;

        if (parsedLocation && parsedLocation.lng && parsedLocation.lat) {
            targetCoords = [parseFloat(parsedLocation.lng), parseFloat(parsedLocation.lat)];
        } else if (rider.address || address) {
            const searchAddress = address || rider.address;
            const coords = await geocodingService.getCoordinates(searchAddress);
            if (coords) {
                targetCoords = [coords.lng, coords.lat];
            }
        }

        if (targetCoords) {
            const locObj = {
                type: 'Point',
                coordinates: targetCoords
            };
            rider.location = locObj;
            rider.currentLocation = {
                ...locObj,
                lastUpdated: new Date()
            };
        }

        // Vehicle info
        rider.vehicleType = vehicleType || rider.vehicleType;
        rider.vehicleNumber = vehicleNumber || rider.vehicleNumber;
        rider.vehicleModel = vehicleModel || rider.vehicleModel;

        // Documents numbers
        rider.licenseNumber = licenseNumber || rider.licenseNumber;
        if (licenseExpiryDate) rider.licenseExpiryDate = new Date(licenseExpiryDate);
        rider.aadharNumber = aadharNumber || rider.aadharNumber;
        rider.panNumber = panNumber || rider.panNumber;

        // Document photos.
        // multer uses memoryStorage, so uploaded files expose `.buffer` — NOT
        // `.path`. Reading `.path` silently stored `undefined` and dropped the
        // file entirely. Upload identity docs to private storage and the
        // profile photo to public storage.
        const uploadPrivateDoc = async (fileArray) => {
            if (!fileArray?.[0]) return undefined;
            const result = await uploadService.uploadPrivateFile(
                fileArray[0].buffer,
                'rider-docs',
                fileArray[0].mimetype
            );
            return result.url;
        };

        const licenseUrl = await uploadPrivateDoc(files.licensePhoto);
        if (licenseUrl) rider.licensePhoto = licenseUrl;

        const aadharUrl = await uploadPrivateDoc(files.aadharPhoto);
        if (aadharUrl) rider.aadharPhoto = aadharUrl;

        const panUrl = await uploadPrivateDoc(files.panPhoto);
        if (panUrl) rider.panPhoto = panUrl;

        if (files.profilePhoto?.[0]) {
            const profileResult = await uploadService.uploadPublicImage(
                files.profilePhoto[0].buffer,
                'profiles'
            );
            rider.image = profileResult.url;
        }

        // Bank info
        rider.bankAccountNumber = bankAccountNumber || rider.bankAccountNumber;
        rider.ifscCode = ifscCode || rider.ifscCode;
        rider.accountHolderName = accountHolderName || rider.accountHolderName;

        // Emergency contact
        if (emergencyContactName || emergencyContactMobile || emergencyContactRelation) {
            rider.emergencyContact = {
                name: emergencyContactName || rider.emergencyContact?.name,
                mobile: emergencyContactMobile || rider.emergencyContact?.mobile,
                relation: emergencyContactRelation || rider.emergencyContact?.relation
            };
        }

        rider.isProfileComplete = true;
        await rider.save();

        // Log Activity
        await activityLogService.log(req, {
            action: 'complete_profile',
            resource: 'user',
            resourceId: rider._id,
            details: { name: rider.name, role: 'rider' }
        });

        res.json({
            success: true,
            message: 'Profile completed successfully. Pending administrator approval.',
            rider: {
                _id: rider._id,
                readableId: rider.readableId,
                name: rider.name,
                isApproved: rider.isApproved,
                isProfileComplete: rider.isProfileComplete
            }
        });

    } catch (error) {
        logger.error('Complete Profile Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to complete profile',
            error: error.message
        });
    }
};

// Toggle Online/Offline Status
export const toggleAvailability = async (req, res) => {
    try {
        const { isOnline, location } = req.body;
        const rider = req.rider;

        if (!rider) {
            return res.status(401).json({
                success: false,
                message: 'Rider not authenticated'
            });
        }

        // Going offline mid-trip abandons an order a customer is waiting on and
        // kills the GPS the shop and customer are tracking. The app guards this,
        // but the endpoint has to as well — a client guard is only a suggestion.
        if (isOnline === false) {
            const Delivery = mongoose.model('Delivery');
            const active = await Delivery.exists({
                riderId: rider._id,
                status: { $nin: ['delivered', 'cancelled', 'rejected'] }
            });
            if (active) {
                return res.status(409).json({
                    success: false,
                    message: 'Finish your active delivery before going offline.'
                });
            }
        }

        const updateFields = { isOnline: isOnline };
        if (location) {
            updateFields.currentLocation = {
                type: 'Point',
                coordinates: [location.lng, location.lat],
                lastUpdated: new Date()
            };
        }

        await Rider.findByIdAndUpdate(rider._id, { $set: updateFields });

        // Log Activity
        await activityLogService.log(req, {
            action: isOnline ? 'activate' : 'deactivate',
            resource: 'user',
            resourceId: rider._id,
            details: { name: rider.name, role: 'rider', type: 'availability' }
        });

        // Emit Socket Event
        try {
            const io = req.app.get('io');
            if (io) {
                const event = isOnline ? 'rider:online' : 'rider:offline';
                io.to(SOCKET_ROOMS.role('admin')).emit(event, {
                    riderId: rider._id,
                    name: rider.name,
                    location: rider.currentLocation
                });
                io.to(SOCKET_ROOMS.role('manager')).emit(event, {
                    riderId: rider._id,
                    name: rider.name,
                    location: rider.currentLocation
                });
            }
        }
        catch (socketError) {
            logger.warn('Socket emission failed:', socketError.message);
        }

        if (isOnline) {
            riderAssignmentService.processWaitingOrders(req.app.get('io'));
        }

        res.json({
            success: true,
            message: `You are now ${isOnline ? 'Online' : 'Offline'}`,
            data: { isOnline: isOnline }
        });

    } catch (error) {
        logger.error('Error in toggleAvailability:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update status',
            error: error.message
        });
    }
};

// Update FCM Token
export const updateFCMToken = async (req, res) => {
    try {
        const { fcmToken } = req.body;
        const riderId = req.user.userId;

        if (!fcmToken) {
            return res.status(400).json({ success: false, message: 'FCM token required' });
        }

        await Rider.findByIdAndUpdate(riderId, { $set: { fcmToken } });

        res.json({ success: true, message: 'FCM token updated' });
    } catch (error) {
        logger.error('Error updating Rider FCM token:', error);
        res.status(500).json({ success: false, message: 'Failed to update token' });
    }
};

// Get Profile
export const getProfile = async (req, res) => {
    try {
        const riderId = req.user.userId;

        // Ensure metrics are up to date before returning profile
        await riderMetricsService.updateMetrics(riderId);

        // Fetch fresh doc from DB (middleware might have stale one)
        const freshRider = await Rider.findById(riderId);

        // This spreads the whole document, so the PIN hash would ride along to
        // the client. Drop it explicitly.
        const { verificationPin, ...safeRider } = freshRider.toObject();

        res.json({
            success: true,
            data: {
                ...safeRider,
                id: freshRider._id,
                isApproved: freshRider.isApproved,
                isProfileComplete: freshRider.isProfileComplete
            } 
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Fetch failed' });
    }
};

// Firebase Login
export const firebaseLogin = async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) return res.status(400).json({ success: false, message: 'ID token required' });

        const decoded = await verifyFirebaseToken(idToken);
        const mobile = decoded.phone_number.replace(/\D/g, '').slice(-10);

        let rider = await Rider.findOne({ mobile });
        let isNewUser = false;

        if (!rider) {
            isNewUser = true;
            rider = new Rider({
                mobile,
                role: 'rider',
                isApproved: false,
                isProfileComplete: false,
                vehicleType: 'bike',
                vehicleNumber: 'PENDING',
                licenseNumber: 'PENDING',
                licenseExpiryDate: new Date(),
                aadharNumber: 'PENDING'
            });
            await rider.save();
            logger.info('New rider registered via Firebase', { mobile, userId: rider._id });
        }

        const token = generateToken({ userId: rider._id, role: 'rider' });
        const refreshToken = generateRefreshToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: rider._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Log Activity
        await activityLogService.log(req, {
            adminId: rider._id,
            action: 'firebase_login',
            resource: 'user',
            resourceId: rider._id,
            details: { mobile: rider.mobile, role: 'rider', isNewUser }
        });

        res.json({
            success: true,
            message: 'Logged in successfully',
            token,
            refreshToken,
            rider: {
                id: rider._id,
                readableId: rider.readableId,
                name: rider.name,
                mobile: rider.mobile,
                role: 'rider',
                isApproved: rider.isApproved,
                isOnline: rider.isOnline,
                isProfileComplete: rider.isProfileComplete || false
            },
            isNewUser
        });
    } catch (error) {
        logger.error('Firebase login error (Rider):', error);
        res.status(401).json({ success: false, message: error.message });
    }
};

// What a rider gets back once signed in (PIN login and PIN reset).
// Never echo the PIN back — it's a hash now, and returning it to the client
// served no purpose but to leak the credential.
const signedInRider = (rider) => ({
    id: rider._id,
    readableId: rider.readableId,
    name: rider.name,
    mobile: rider.mobile,
    email: rider.email,
    role: 'rider',
    isApproved: rider.isApproved,
    isOnline: rider.isOnline,
    isProfileComplete: rider.isProfileComplete || false,
    totalDeliveries: rider.totalDeliveries,
    totalEarnings: rider.totalEarnings,
    averageRating: rider.averageRating,
    vehicleType: rider.vehicleType,
    vehicleNumber: rider.vehicleNumber,
    vehicleModel: rider.vehicleModel,
    licenseNumber: rider.licenseNumber,
    licenseExpiryDate: rider.licenseExpiryDate,
    licensePhoto: rider.licensePhoto,
    aadharNumber: rider.aadharNumber,
    aadharPhoto: rider.aadharPhoto,
    emergencyContact: rider.emergencyContact,
    bankAccountNumber: rider.bankAccountNumber,
    ifscCode: rider.ifscCode,
    accountHolderName: rider.accountHolderName
});

// Rider Mobile & PIN Login (Bypasses Firebase for quick verification/testing/onboarding fallback)
export const loginRider = async (req, res) => {
    try {
        const { mobile, pin } = req.body;
        if (!mobile || !pin) {
            return res.status(400).json({ success: false, message: 'Mobile number and PIN are required' });
        }

        // verificationPin is `select: false` on the schema, so it never rides
        // along on an ordinary query. This is the one place that needs it.
        const rider = await Rider.findOne({ mobile }).select('+verificationPin');

        // One generic failure for "no such rider" AND "wrong PIN". Answering
        // 404 vs 400 let anyone enumerate which phone numbers are registered
        // riders. The old code also "self-healed" a missing PIN by generating a
        // random one and saving it — then failing the compare, permanently
        // locking that rider out of a PIN nobody could ever tell them.
        const invalid = () => res.status(401).json({
            success: false,
            message: 'Invalid mobile number or PIN'
        });

        if (!rider || !rider.verificationPin) return invalid();

        // Backward-compatible check. PINs used to be stored in the clear; a
        // straight switch to bcrypt.compare would have locked out every
        // existing rider the moment this deployed. So: hashed PINs compare
        // normally, and a legacy plaintext PIN is accepted once and upgraded to
        // a hash in place, which drains the plaintext away as riders sign in.
        const stored = rider.verificationPin;
        const isHashed = stored.startsWith('$2');

        let pinOk;
        if (isHashed) {
            pinOk = await bcrypt.compare(String(pin), stored);
        } else {
            pinOk = stored === String(pin);
            if (pinOk) {
                await User.findByIdAndUpdate(rider._id, {
                    verificationPin: await bcrypt.hash(String(pin), 10)
                });
                logger.info('Upgraded legacy plaintext rider PIN to a hash', {
                    riderId: rider._id
                });
            }
        }

        if (!pinOk) return invalid();

        const token = generateToken({ userId: rider._id, role: 'rider' });
        const refreshToken = generateRefreshToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: rider._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        res.json({
            success: true,
            message: 'Logged in successfully',
            token,
            refreshToken,
            rider: signedInRider(rider)
        });
    } catch (error) {
        logger.error('Rider login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
};

/* ======================================================
   SELF-SERVICE PIN RESET

   PINs are bcrypt-hashed, so a forgotten one cannot be looked up, only
   replaced. The rider proves they hold the registered phone with a Firebase
   SMS OTP (the app sends the resulting ID token), picks a new PIN, and is
   signed in. Every other session is ended, and admins and managers are told —
   on the rider record, over the socket and by push — so a reset nobody
   expected does not go unnoticed.
====================================================== */

// A PIN anyone would try first is no PIN.
const WEAK_PINS = new Set(['1234', '4321', '0123', '2345', '3456', '4567', '5678', '6789', '9876']);
const isWeakPin = (pin) => /^(\d)\1{3}$/.test(pin) || WEAK_PINS.has(pin);

// How long after the OTP was verified the token may still be used for a reset.
const RESET_TOKEN_MAX_AGE_SECONDS = 10 * 60;

export const resetPin = async (req, res) => {
    try {
        const { idToken } = req.body;
        const newPin = String(req.body.newPin ?? '');

        if (!idToken) {
            return res.status(400).json({ success: false, message: 'Phone verification is required' });
        }
        if (!/^\d{4}$/.test(newPin)) {
            return res.status(400).json({ success: false, message: 'Your PIN must be exactly 4 digits' });
        }
        if (isWeakPin(newPin)) {
            return res.status(400).json({
                success: false,
                message: 'That PIN is too easy to guess. Please choose a different one.'
            });
        }

        let decoded;
        try {
            decoded = await verifyFirebaseToken(idToken);
        } catch {
            return res.status(401).json({
                success: false,
                message: 'We could not verify your number. Please request a new code.'
            });
        }

        // Only a phone sign-in proves possession of the number, and only a
        // fresh one: an ID token is good for an hour and refreshes silently, so
        // without the age check an old sign-in left on a handed-down phone
        // could reset the PIN long after the OTP was typed.
        const authAge = decoded.auth_time ? Date.now() / 1000 - decoded.auth_time : 0;
        if (!decoded.phone_number || authAge > RESET_TOKEN_MAX_AGE_SECONDS) {
            return res.status(401).json({
                success: false,
                message: 'Your verification has expired. Please request a new code.'
            });
        }

        const mobile = decoded.phone_number.replace(/\D/g, '').slice(-10);
        const rider = await Rider.findOne({ mobile });

        // The caller has proved they own this number, so saying there is no
        // rider on it gives away nothing they could not already find out.
        if (!rider) {
            return res.status(404).json({
                success: false,
                message: 'There is no rider account on this number. Tap "Join the crew" to register.'
            });
        }
        if (rider.isActive === false) {
            return res.status(403).json({
                success: false,
                message: 'This account has been deactivated. Please contact the store.'
            });
        }

        const now = new Date();
        const updated = await Rider.findByIdAndUpdate(
            rider._id,
            {
                $set: { verificationPin: await bcrypt.hash(newPin, 10), pinResetAt: now },
                $inc: { pinResetCount: 1 }
            },
            { new: true }
        );

        // Whoever knew the old PIN — or holds a phone still signed in with it —
        // is signed out. (An access token already issued lives out its hour.)
        await RefreshToken.updateMany(
            { user: rider._id, isRevoked: false },
            { $set: { isRevoked: true, revokedAt: now } }
        );

        const token = generateToken({ userId: rider._id, role: 'rider' });
        const refreshToken = generateRefreshToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);
        await RefreshToken.create({
            token: refreshToken,
            user: rider._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        logger.info('Rider reset their PIN', { riderId: rider._id, resetCount: updated.pinResetCount });

        // Telling the team must never fail the reset the rider has just done.
        try {
            const payload = {
                riderId: rider._id,
                readableId: rider.readableId,
                name: rider.name,
                mobile: rider.mobile,
                pinResetAt: now,
                pinResetCount: updated.pinResetCount
            };
            const socketService = req.app.get('socketService');
            if (socketService) {
                for (const role of ['admin', 'manager']) {
                    socketService.notifyRole(role, SOCKET_EVENTS.RIDER_PIN_RESET, payload);
                    // The panels already refresh their rider list on this one.
                    socketService.notifyRole(role, SOCKET_EVENTS.RIDER_STATUS_UPDATED, payload);
                }
            }
            await notificationService.notifyAdmins(User, {
                title: 'Rider reset their PIN',
                body: `${rider.name || 'A rider'} (${rider.mobile}) reset their login PIN.`,
                data: { type: 'rider_pin_reset', riderId: String(rider._id) }
            });
        } catch (notifyError) {
            logger.warn('PIN reset: could not notify admins', { error: notifyError.message });
        }

        res.json({
            success: true,
            message: 'Your PIN has been changed.',
            token,
            refreshToken,
            rider: signedInRider(updated)
        });
    } catch (error) {
        logger.error('Rider PIN reset error:', error);
        res.status(500).json({ success: false, message: 'Could not reset your PIN. Please try again.' });
    }
};

// Serve private documents (Authenticated Rider or Admin only)
export const getDocument = async (req, res) => {
    try {
        const { filename } = req.params;
        const folder = req.query.folder || 'temp';

        // Ensure path traversal is prevented
        const sanitizedFilename = path.basename(filename);
        const sanitizedFolder = path.basename(folder);

        // Ownership check: a rider may only fetch their own documents
        // (identity docs on their Rider record, or proofs of their own
        // deliveries). Without this, any authenticated rider could pull
        // another rider's Aadhaar/PAN/licence by filename.
        const rider = req.rider;
        const ownDocUrls = [rider?.licensePhoto, rider?.aadharPhoto, rider?.panPhoto, rider?.profilePhoto]
            .filter(Boolean);
        let isOwner = ownDocUrls.some(url => url.includes(sanitizedFilename));

        if (!isOwner && rider) {
            const Delivery = (await import('../../models/Delivery.js')).default;
            const proofOwner = await Delivery.exists({
                riderId: rider._id,
                deliveryProof: { $regex: sanitizedFilename, $options: 'i' }
            });
            isOwner = Boolean(proofOwner);
        }

        if (!isOwner) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const privateRoot = process.env.STORAGE_PRIVATE_PATH || path.join(process.cwd(), 'uploads', 'private');
        const absolutePath = path.join(privateRoot, sanitizedFolder, sanitizedFilename);

        if (!fs.existsSync(absolutePath)) {
            return res.status(404).send('File not found');
        }

        res.sendFile(absolutePath);
    } catch (error) {
        logger.error('Error serving document:', error);
        res.status(500).send('Internal Server Error');
    }
};

/* ==================================================
   UPDATE A SINGLE RIDER DOCUMENT (re-upload from profile)
   Safe: touches only the one field, never the rest of the profile.
================================================== */
export const updateRiderDocument = async (req, res) => {
    try {
        const rider = await Rider.findById(req.user.userId);
        if (!rider) {
            return res.status(404).json({ success: false, message: 'Rider not found' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file received' });
        }

        const { docType } = req.body;
        const allowed = {
            aadharPhoto: 'private',
            licensePhoto: 'private',
            panPhoto: 'private',
            profilePhoto: 'public',
        };
        if (!allowed[docType]) {
            return res.status(400).json({ success: false, message: 'Invalid document type' });
        }

        let url;
        if (allowed[docType] === 'public') {
            const result = await uploadService.uploadPublicImage(req.file.buffer, 'profiles');
            url = result.url;
            rider.image = url;
        } else {
            const result = await uploadService.uploadPrivateFile(req.file.buffer, 'rider-docs', req.file.mimetype);
            url = result.url;
            rider[docType] = url;
        }

        await rider.save();
        res.json({ success: true, message: 'Document updated', data: { docType, url } });
    } catch (error) {
        logger.error('updateRiderDocument error', error);
        res.status(500).json({ success: false, message: 'Could not update the document' });
    }
};

/* ======================================================
   DELETE MY ACCOUNT

   Deactivates and anonymises the rider (see accountDeletionService). Refused
   mid-delivery or with earnings still owed. The team is told, because a rider
   disappearing from the roster is something they need to know about.
====================================================== */
export const deleteAccount = async (req, res) => {
    try {
        const deleted = await deleteRiderAccount(req.user.userId);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Rider not found' });
        }

        try {
            const socketService = req.app.get('socketService');
            for (const role of ['admin', 'manager']) {
                socketService?.notifyRole(role, SOCKET_EVENTS.RIDER_STATUS_UPDATED, {
                    riderId: deleted.id,
                    status: 'deleted',
                    name: deleted.name
                });
            }
            await notificationService.notifyAdmins(User, {
                title: 'Rider deleted their account',
                body: `${deleted.name || 'A rider'} (${deleted.mobile}) deleted their rider account.`,
                data: { type: 'rider_account_deleted', riderId: String(deleted.id) }
            });
        } catch (notifyError) {
            logger.warn('Account deletion: could not notify admins', { error: notifyError.message });
        }

        res.json({ success: true, message: 'Your account has been deleted.' });
    } catch (error) {
        if (error instanceof DeletionBlockedError) {
            return res.status(409).json({ success: false, message: error.message });
        }
        logger.error('Rider account deletion error:', error);
        res.status(500).json({ success: false, message: 'Could not delete your account. Please try again.' });
    }
};

/* ======================================================
   REFRESH ACCESS TOKEN

   The rider access token lives for 1 hour. Login and register have always
   minted a 90-day refresh token and handed it back — but there was no route to
   redeem it, and the app never stored it. So every rider was signed out an hour
   into their shift, potentially mid-delivery, and had to re-enter a PIN they
   very likely don't have memorised (and which, now that PINs are hashed, nobody
   can look up for them).

   Mirrors the customer flow, including refresh-token rotation.
====================================================== */
export const refreshRiderToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(401).json({
                success: false,
                message: 'Refresh token required'
            });
        }

        const stored = await RefreshToken.findOne({
            token: refreshToken,
            isRevoked: false
        }).populate('user');

        if (!stored || !stored.user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or revoked refresh token'
            });
        }

        if (stored.expiresAt < new Date()) {
            return res.status(401).json({
                success: false,
                message: 'Your session expired. Please sign in again.'
            });
        }

        // A rider who has been deactivated must not be able to refresh their way
        // back into an active session.
        if (stored.user.isActive === false) {
            return res.status(403).json({
                success: false,
                message: 'This account is no longer active.'
            });
        }

        // Rotation: burn the presented token, issue a fresh pair.
        const newRefreshToken = generateRefreshToken();
        stored.isRevoked = true;
        stored.revokedAt = new Date();
        stored.replacedBy = newRefreshToken;
        await stored.save();

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: newRefreshToken,
            user: stored.user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        const token = generateToken({ userId: stored.user._id, role: 'rider' });

        logger.info('Rider token refreshed', { userId: stored.user._id });

        return res.json({
            success: true,
            token,
            refreshToken: newRefreshToken
        });
    } catch (error) {
        logger.error('refreshRiderToken error', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};
