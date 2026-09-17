import mongoose from "mongoose";
import Rider from "../models/Rider.js";
import User from "../models/User.js";
import Order from "../models/Order.js";
import { getDistance } from "../utils/geoUtils.js";
import logger from "../config/logger.js";
import { notificationService } from "./notificationService.js";
import crypto from "crypto";

/// A fresh 4-digit code for one delivery leg. Uses the CSPRNG rather than
/// Math.random so codes aren't predictable from one another.
const generateOtp = () => String(crypto.randomInt(1000, 10000));

const BRAND_OUTLETS = {
    littleh: {
        name: 'LittleH Bakery (Amaravathi Road)',
        coordinates: [80.4309655, 16.3090654], // [lng, lat]
        lat: 16.3090654,
        lng: 80.4309655
    },
    teasntrees: {
        name: 'Teas N Trees (Lakshmipuram)',
        coordinates: [80.4187407, 16.314207], // [lng, lat]
        lat: 16.314207,
        lng: 80.4187407
    }
};


class RiderAssignmentService {
    CONFIG = {
        MAX_ASSIGNMENT_DISTANCE: process.env.NODE_ENV === 'production' ? 15000 : 500000, // 500KM for testing
        SEARCH_RADIUS: 10000,
        AUTO_ASSIGN_TIMEOUT: 30000, // 30s rider response window
        ESCALATION_TIME: 5 * 60 * 1000 // 5 minutes
    };

    io = null;
    monitorInterval = null;

    setIo(io) {
        this.io = io;
        this.startEscalationMonitor();
    }

    startEscalationMonitor() {
        if (this.monitorInterval) return;

        // Same guard as the nudge worker: only the production instance should
        // run monitors that push real notifications (escalations go to admin FCM).
        if (process.env.ENABLE_BACKGROUND_JOBS === 'false') {
            logger.info("[RiderAssignment] Escalation Monitor disabled via ENABLE_BACKGROUND_JOBS=false");
            return;
        }

        logger.info("[RiderAssignment] Starting Escalation Monitor...");
        this.monitorInterval = setInterval(() => {
            this.checkEscalations();
        }, 60000); // Check every minute
    }

    async checkEscalations() {
        try {
            const Order = mongoose.model('Order');
            const now = new Date();
            const cutoff = new Date(now.getTime() - this.CONFIG.ESCALATION_TIME);

            // Find orders stuck in waiting_for_rider for too long that have
            // not already been escalated since their last state change.
            const stuckOrders = await Order.find({
                status: 'waiting_for_rider',
                updatedAt: { $lt: cutoff },
                $or: [
                    { escalatedAt: null },
                    { escalatedAt: { $exists: false } },
                    { $expr: { $lt: ['$escalatedAt', '$updatedAt'] } }
                ]
            });

            if (stuckOrders.length > 0) {
                logger.warn(`[RiderAssignment] Escalating ${stuckOrders.length} stuck orders`);
                
                const User = mongoose.model('User');
                for (const order of stuckOrders) {
                    // Alert Admins/Managers via Socket
                    if (this.io) {
                        this.io.to("role:admin").to("role:manager").emit("order:escalated", {
                            orderId: order._id,
                            orderNumber: order.orderNumber,
                            waitingTime: Math.round((now - order.updatedAt) / 60000)
                        });
                    }

                    // Push notification to admins
                    await notificationService.notifyAdmins(User, {
                        title: '⚠️ Order Escalation',
                        body: `Order #${order.orderNumber} is waiting for a rider for ${Math.round((now - order.updatedAt) / 60000)} mins!`,
                        data: { orderId: order._id.toString(), type: 'escalation' }
                    });
                }

                // Mark as escalated without touching updatedAt, so each stuck
                // order alerts staff exactly once per state change.
                await Order.updateMany(
                    { _id: { $in: stuckOrders.map(o => o._id) } },
                    { $set: { escalatedAt: now } },
                    { timestamps: false }
                );
            }
        } catch (err) {
            logger.error("[RiderAssignment] Escalation check failed:", err);
        }
    }

    emitRiderStatus(riderId, statusData) {
        if (this.io) {
            // Rider status concerns the rider themself and staff dashboards —
            // not every connected customer.
            this.io.to(`user:${riderId}`).to('role:admin').to('role:manager')
                .emit('rider:status-updated', {
                    riderId,
                    ...statusData,
                    timestamp: new Date()
                });
        }
    }

    /* ======================================================
       FIND BEST RIDER (USING $geoNear AGGREGATION)
    ====================================================== */
    async findBestRider(customerLocation, outletLocation, excludeRiderIds = []) {
        try {
            const now = new Date();
            
            // DIAGNOSTIC: Check all online riders first
            const allOnlineRiders = await Rider.find({ isOnline: true }).select('name isApproved isActive isOnDelivery lockUntil currentLocation');
            logger.info(`[RiderAssignment] Diagnostic: Found ${allOnlineRiders.length} riders currently ONLINE.`);
            allOnlineRiders.forEach(r => {
                logger.info(`[RiderAssignment]   - Rider: ${r.name}, Approved: ${r.isApproved}, Active: ${r.isActive}, Busy: ${r.isOnDelivery}, Lock: ${r.lockUntil > now ? 'Active' : 'None'}, Loc: ${JSON.stringify(r.currentLocation?.coordinates)}`);
            });

            // Build the match stage for availability
            const matchStage = {
                isOnline: true,
                isApproved: true,
                isActive: true,
                // Available if NOT on delivery OR if the lock has expired (Ghost Rider prevention)
                $or: [
                    { isOnDelivery: false },
                    { lockUntil: { $lt: now, $ne: null } },
                    { lockUntil: null }
                ]
            };

            if (excludeRiderIds.length > 0) {
                matchStage._id = { $nin: excludeRiderIds.map(id => new mongoose.Types.ObjectId(id)) };
            }

            const outletLng = outletLocation?.lng || BRAND_OUTLETS.teasntrees.lng;
            const outletLat = outletLocation?.lat || BRAND_OUTLETS.teasntrees.lat;

            const pipeline = [
                {
                    $geoNear: {
                        near: { type: "Point", coordinates: [outletLng, outletLat] },
                        key: "currentLocation",
                        distanceField: "distanceToOutlet",
                        maxDistance: this.CONFIG.MAX_ASSIGNMENT_DISTANCE,
                        query: matchStage,
                        spherical: true
                    }
                },
                { $limit: 20 } // Process top 20 candidates
            ];

            const riders = await Rider.aggregate(pipeline);

            if (!riders.length) {
                logger.debug("[RiderAssignment] No riders available nearby via geoNear");
                return null;
            }

            // Score the candidates
            const scored = riders.map(rider => {
                const score = this.calculateRiderScore(
                    rider,
                    customerLocation,
                    { lat: outletLat, lng: outletLng },
                    rider.distanceToOutlet
                );
                return { ...rider, score };
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score);

            return scored.length ? scored[0] : null;

        } catch (err) {
            logger.error("[RiderAssignment] findBestRider error", err);
            return null;
        }
    }

    /* ======================================================
       ATOMIC LOCK (ON ASSIGNMENT)
    ====================================================== */
    async atomicLockRider(riderId) {
        const now = new Date();
        const lockDuration = 45000; // 45 seconds for the rider to respond
        const lockUntil = new Date(now.getTime() + lockDuration);

        return Rider.findOneAndUpdate(
            { 
                _id: riderId,
                $or: [
                    { isOnDelivery: false },
                    { lockUntil: { $lt: now } }
                ]
            },
            { 
                isOnDelivery: true, 
                lockUntil: lockUntil,
                lastAssignedAt: now 
            },
            { new: true }
        );
    }

    async unlockRider(riderId) {
        await Rider.findByIdAndUpdate(riderId, { 
            isOnDelivery: false,
            lockUntil: null 
        });
    }

    /* ======================================================
       SCORING LOGIC
    ====================================================== */
    calculateRiderScore(rider, customerLocation, outletLocation, distanceToOutlet) {
        let score = 100;

        // distanceToOutlet is provided by $geoNear in meters
        score -= (distanceToOutlet / 1000) * 5;

        if (customerLocation?.lat && customerLocation?.lng && rider.currentLocation?.coordinates) {
            const riderLat = rider.currentLocation.coordinates[1];
            const riderLng = rider.currentLocation.coordinates[0];
            
            const distToCustomer = getDistance(
                riderLat,
                riderLng,
                customerLocation.lat,
                customerLocation.lng
            );
            score -= (distToCustomer / 1000);
        }

        if (rider.averageRating > 4) {
            score += (rider.averageRating - 4) * 20;
        }

        score += Math.min((rider.totalDeliveries || 0) / 100, 10);

        return Math.max(score, 1);
    }

    /* ======================================================
       ASSIGN RIDER WITH RETRY
    ====================================================== */
    async assignRiderWithRetry(order, io, deliveryData, initialExcludedRiders = []) {
        const excludedRiders = [...initialExcludedRiders];
        let attempts = 0;

        const coords = deliveryData.deliveryLocation?.coordinates;
        const customerLocation = coords
            ? { lat: coords[1], lng: coords[0] }
            : null;

        const defaultOutlet = BRAND_OUTLETS[order.brand] || BRAND_OUTLETS.teasntrees;
        const outletLocation = order.pickupLocation?.coordinates ? {
            lat: order.pickupLocation.coordinates[1],
            lng: order.pickupLocation.coordinates[0]
        } : { lat: defaultOutlet.lat, lng: defaultOutlet.lng };

        while (attempts < 5) {
            attempts++;

            const rider = await this.findBestRider(customerLocation, outletLocation, excludedRiders);
            if (!rider) break;

            try {
                // Atomic lock attempt
                const lockedRider = await this.atomicLockRider(rider._id);
                if (!lockedRider) {
                    excludedRiders.push(rider._id);
                    continue;
                }

const User = mongoose.model('User');
            const dbRider = await User.findById(rider._id);
            const dbCustomer = await User.findById(order.customerId);

            // Per-delivery codes. These used to be the users' STATIC
            // verificationPin, which meant the rider's LOGIN PIN was handed to
            // the outlet as the pickup OTP, and the same code worked for every
            // future delivery -- so a rider who served a customer once could
            // close a later order without ever turning up.
            const riderPin = generateOtp();
            const customerPin = generateOtp();

                const DeliveryModel = mongoose.model('Delivery');

                // FOOLPROOF COORDINATE & ADDRESS POPULATION
                const BRAND_LOCS = {
                    littleh: { lng: 80.4309655, lat: 16.3090654, name: 'LittleH Bakery (Amaravathi Road)' },
                    teasntrees: { lng: 80.4187407, lat: 16.314207, name: 'Teas N Trees (Lakshmipuram)' }
                };
                const defLoc = BRAND_LOCS[order.brand] || BRAND_LOCS.teasntrees;

                const finalPickupLoc = {
                    type: 'Point',
                    coordinates: order.pickupLocation?.coordinates?.length === 2 
                        ? order.pickupLocation.coordinates 
                        : [defLoc.lng, defLoc.lat],
                    address: defLoc.name
                };

                const finalDeliveryLoc = {
                    type: 'Point',
                    coordinates: order.deliveryAddress?.location?.coordinates?.length === 2
                        ? order.deliveryAddress.location.coordinates
                        : [defLoc.lng + 0.01, defLoc.lat + 0.01],
                    address: order.deliveryAddress?.address || 'Customer Location'
                };

                const delivery = await DeliveryModel.create({
                    ...deliveryData,
                    brand: order.brand || deliveryData.brand || "teasntrees",
                    riderId: rider._id,
                    status: "pending_acceptance",
                    assignedAt: new Date(),
                    pickupOtp: riderPin,
                    deliveryOtp: customerPin,
                    pickupLocation: finalPickupLoc,
                    deliveryLocation: finalDeliveryLoc,
                    customerName: dbCustomer?.name || 'Customer',
                    customerMobile: dbCustomer?.mobile || '',
                    customerImage: dbCustomer?.profileImage || null,
                customerAltPhone: order.alternatePhone || null,
                    customerAltPhone: order.alternatePhone || null,
                    deliveryAddress: finalDeliveryLoc.address
                });

                // Socket notification
                if (io) {
                    io.to(`user:${rider._id}`).emit("delivery:assigned", {
                        deliveryId: delivery._id,
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        earning: delivery.totalEarning,
                        timeout: 30
                    });

                    io.to("role:admin").to("role:manager").emit("rider:assigned", {
                        orderId: order._id,
                        riderId: rider._id,
                        deliveryId: delivery._id
                    });
                }

                // FCM Fallback
                notificationService.sendPush(dbRider, {
                    title: '🚀 New Delivery Available!',
                    body: `Order #${order.orderNumber} - Earn ₹${delivery.totalEarning}`,
                    data: {
                        deliveryId: delivery._id.toString(),
                        type: 'NEW_DELIVERY'
                    }
                });

                logger.info(`[RiderAssignment] Rider ${rider.name} assigned to order ${order.orderNumber}`);

                return {
                    success: true,
                    delivery,
                    rider,
                    reason: "Rider assigned (awaiting acceptance)"
                };

            } catch (err) {
                logger.error("[RiderAssignment] Assignment error", err);
                excludedRiders.push(rider._id);
                await this.unlockRider(rider._id);
            }
        }

        if (io) {
            io.to("role:admin").to("role:manager").emit("rider:assignment-failed", {
                orderId: order._id,
                orderNumber: order.orderNumber
            });
        }

        return {
            success: false,
            delivery: null,
            rider: null,
            reason: "No riders available"
        };
    }

    /* ======================================================
       CREATE OR UPDATE DELIVERY (MANUAL ASSIGNMENT)
    ====================================================== */
    async createOrUpdateDelivery(order, rider) {
        try {
            // 1. Atomic lock: Set rider as busy
            const locked = await this.atomicLockRider(rider._id);
            if (!locked) throw new Error('Rider is currently busy or locked');

            const DeliveryModel = mongoose.model('Delivery');
            // 2. Find or Create Delivery
            let delivery = await DeliveryModel.findOne({ orderId: order._id });

            if (delivery) {
                if (['delivered', 'cancelled'].includes(delivery.status)) {
                    throw new Error('Cannot reassign rider for a terminal delivery');
                }
                delivery.riderId = rider._id;
                delivery.brand = order.brand || delivery.brand;
                delivery.status = 'pending_acceptance';
                delivery.assignedAt = new Date();
                await delivery.save();
                return delivery;
            }

            const defaultOutlet = BRAND_OUTLETS[order.brand] || BRAND_OUTLETS.teasntrees;
            const outletLocation = order.pickupLocation?.coordinates ? {
                lat: order.pickupLocation.coordinates[1],
                lng: order.pickupLocation.coordinates[0]
            } : { lat: defaultOutlet.lat, lng: defaultOutlet.lng };

            const deliveryLocation = order.deliveryAddress?.location;

            if (!deliveryLocation?.coordinates) {
                throw new Error('Order has no delivery coordinates');
            }

            const distance = getDistance(
                outletLocation.lat,
                outletLocation.lng,
                deliveryLocation.coordinates[1],
                deliveryLocation.coordinates[0]
            );

const User = mongoose.model('User');
            const dbRider = await User.findById(rider._id);
            const dbCustomer = await User.findById(order.customerId);

            // Per-delivery codes. These used to be the users' STATIC
            // verificationPin, which meant the rider's LOGIN PIN was handed to
            // the outlet as the pickup OTP, and the same code worked for every
            // future delivery -- so a rider who served a customer once could
            // close a later order without ever turning up.
            const riderPin = generateOtp();
            const customerPin = generateOtp();

            const deliveryData = {
                orderId: order._id,
                brand: order.brand,
                riderId: rider._id,
                customerId: order.customerId,
                customerName: dbCustomer?.name || 'Customer',
                customerMobile: dbCustomer?.mobile || '',
                customerImage: dbCustomer?.profileImage || null,
                pickupLocation: {
                    type: 'Point',
                    coordinates: [outletLocation.lng, outletLocation.lat],
                    address: BRAND_OUTLETS[order.brand]?.name || 'Outlet'
                },
                deliveryLocation: {
                    ...deliveryLocation,
                    address: order.deliveryAddress?.address || 'Customer Address'
                },
                deliveryAddress: order.deliveryAddress?.address || 'Customer Address',
                distance,
                baseEarning: order.riderEarning || 20,
                totalEarning: order.riderEarning || 20,
                status: 'pending_acceptance',
                assignedAt: new Date(),
                pickupOtp: riderPin,
                deliveryOtp: customerPin
            };

            delivery = await DeliveryModel.create(deliveryData);

            // Manual assign FCM
            notificationService.sendPush(dbRider, {
                title: '📌 Manual Assignment',
                body: `Admin assigned you to Order #${order.orderNumber}`,
                data: { deliveryId: delivery._id.toString(), type: 'MANUAL_ASSIGN' }
            });

            return delivery;

        } catch (err) {
            logger.error(`[RiderAssignment] createOrUpdateDelivery failed: ${err.message}`);
            await this.unlockRider(rider._id);
            throw err;
        }
    }

    /* ======================================================
       PROCESS WAITING ORDERS (BACKGROUND / TRIGGERED)
    ====================================================== */
    async processWaitingOrders(io) {
        try {
            const Order = mongoose.model('Order');
            const pendingOrders = await Order.find({
                status: 'waiting_for_rider',
                riderId: { $exists: false }
            }).limit(10); // Batch process

            if (!pendingOrders.length) return;

            logger.info(`[RiderAssignment] Scanning ${pendingOrders.length} waiting orders...`);

            const Settings = mongoose.model('Settings');

            for (const order of pendingOrders) {
                const settings = (await Settings.findOne({ brand: order.brand })) || {};
                const base = settings.riderBaseEarning || 20;
                const rate = settings.distanceBonusPerKm || 5;

                const coords = order.deliveryAddress?.location?.coordinates;
                if (!coords || coords.length !== 2) continue;

                const defaultOutlet = BRAND_OUTLETS[order.brand] || BRAND_OUTLETS.teasntrees;
                const outletLocation = order.pickupLocation?.coordinates ? {
                    lat: order.pickupLocation.coordinates[1],
                    lng: order.pickupLocation.coordinates[0]
                } : { lat: defaultOutlet.lat, lng: defaultOutlet.lng };

                const distance = getDistance(
                    outletLocation.lat,
                    outletLocation.lng,
                    coords[1],
                    coords[0]
                );

                await this.assignRiderWithRetry(
                    order,
                    io,
                    {
                        orderId: order._id,
                        brand: order.brand,
                        customerId: order.customerId,
                        pickupLocation: {
                            type: 'Point',
                            coordinates: [outletLocation.lng, outletLocation.lat],
                            address: BRAND_OUTLETS[order.brand]?.name || 'Outlet'
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
        } catch (err) {
            logger.error("[RiderAssignment] processWaitingOrders failed:", err);
        }
    }

    /* ======================================================
       SYNC RIDER STATUS (SELF-HEALING)
    ====================================================== */
    async syncRiderStatus(riderId) {
        try {
            const Rider = mongoose.model('Rider');
            const [activeDelivery, rider] = await Promise.all([
                mongoose.model('Delivery').findOne({
                    riderId,
                    status: { $nin: ['delivered', 'cancelled', 'rejected'] }
                }),
                Rider.findById(riderId).select('isOnDelivery')
            ]);

            const shouldBeOnDelivery = !!activeDelivery;

            if (rider && rider.isOnDelivery !== shouldBeOnDelivery) {
                await Rider.findByIdAndUpdate(riderId, {
                    isOnDelivery: shouldBeOnDelivery
                });
                this.emitRiderStatus(riderId, { isOnDelivery: shouldBeOnDelivery, isBusy: shouldBeOnDelivery });
                logger.info(`[RiderSync] Status repaired for rider ${riderId}. New isOnDelivery: ${shouldBeOnDelivery}`);
            }

            return shouldBeOnDelivery;
        } catch (err) {
            logger.error(`[RiderSync] Failed to sync rider ${riderId}: ${err.message}`);
            return false;
        }
    }
}

export const riderAssignmentService = new RiderAssignmentService();
