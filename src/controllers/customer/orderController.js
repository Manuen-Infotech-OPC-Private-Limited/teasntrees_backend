import mongoose from 'mongoose';
import { assertPaymentMethodAllowed } from '../../utils/paymentGuard.js';
import { beginIdempotentOrder, releaseIdempotencyKey } from '../../utils/idempotency.js';
import Order from '../../models/Order.js';
import Product from '../../models/Product.js';
import Category from '../../models/Category.js';
import User from '../../models/User.js';
import Delivery from '../../models/Delivery.js';
import OrderComplaint from '../../models/OrderComplaint.js';
import Coupon from '../../models/Coupon.js';
import PDFDocument from 'pdfkit';
import logger from '../../config/logger.js';
import { notificationService } from '../../services/notificationService.js';
import { SOCKET_EVENTS, SOCKET_ROOMS } from '../../sockets/socketEvents.js';
import { statsService } from '../../services/statsService.js';
import { isCakeCategoryName } from '../../utils/cakeUtils.js';
import Settings from '../../models/Settings.js'
import Outlet from '../../models/Outlet.js'

/* =========================================================
   CREATE ORDER (CUSTOMER)
========================================================= */
/**
 * A single line can't exceed this. Nobody legitimately orders 100 lattes through
 * the app, and an unbounded quantity is an easy way to make a nonsense order the
 * kitchen has to phone the customer about.
 */
const MAX_ITEM_QUANTITY = 50;

export const createOrder = async (req, res) => {
    try {
        const { items, deliveryAddress, deliveryInstructions, paymentMethod = 'COD', couponCode, location, alternatePhone } = req.body;

        // Reject anything we cannot actually collect money for. Without this a
        // crafted request could place an 'Online' order that no gateway settles
        // and no rider collects cash for.
        const payCheck = assertPaymentMethodAllowed(paymentMethod);
        if (!payCheck.ok) {
            return res.status(400).json({ success: false, message: payCheck.message });
        }

        // Optional alternate contact number. Accept blank; if given, it must be
        // a real 10-digit number so a rider isn't handed garbage to dial.
        const altPhone = (alternatePhone ?? '').toString().trim();
        if (altPhone && !/^[0-9]{10}$/.test(altPhone)) {
            return res.status(400).json({ success: false, message: 'Enter a valid 10-digit alternate number, or leave it blank.' });
        }
        const customerId = req.user.userId;

        // Retrying a checkout must not create a second order. If we already made
        // these orders under this key, replay them; if an identical request is
        // in flight, say so. See utils/idempotency.js.
        const idem = await beginIdempotentOrder(req, res);
        if (idem.handled) return;

        // If this checkout fails for ANY reason, the key must not stay claimed —
        // otherwise a genuine retry is told "already in progress" forever and the
        // customer can never place the order at all. One hook covers every early
        // return and the catch block, so no failure path can forget.
        if (idem.key) {
            res.on('finish', () => {
                if (res.statusCode >= 400) releaseIdempotencyKey(idem.key);
            });
        }

        if (!items || !items.length) {
            return res.status(400).json({ success: false, message: 'Cart is empty' });
        }

        if (!deliveryAddress) {
            return res.status(400).json({ success: false, message: 'Delivery address required' });
        }

        // Handle deliveryAddress as either string or object with pincode
        const pincode = typeof deliveryAddress === 'object' ? deliveryAddress.pincode : null;
        
        // FOOLPROOF LOCATION PARSING
        let finalDeliveryAddress = {
            address: typeof deliveryAddress === 'string' ? deliveryAddress : deliveryAddress.address
        };

        if (location && location.coordinates && location.coordinates.length === 2) {
            finalDeliveryAddress.location = {
                type: 'Point',
                coordinates: location.coordinates, // [lng, lat]
            };
            if (location.address) {
                finalDeliveryAddress.address = `${location.address}: ${finalDeliveryAddress.address}`;
            }
        }

        // 1. Batch fetch products and categories
        const productIds = items.map(i => i.product);
        const products = await Product.find({ _id: { $in: productIds } }).lean();
        const categoryIds = [...new Set(products.map(p => p.category).filter(id => id))];
        const categories = await Category.find({ _id: { $in: categoryIds } }).select('name').lean();

        const productMap = new Map(products.map(p => [p._id.toString(), p]));
        const categoryMap = new Map(categories.map(c => [c._id.toString(), c]));

        const brandsGrouped = {};
        const productUpdates = [];

        for (const item of items) {
            const product = productMap.get(item.product.toString());
            if (!product || !product.isAvailable || product.inStock === false) {
                return res.status(400).json({
                    success: false,
                    message: `Product unavailable`
                });
            }

            // QUANTITY MUST BE A SANE POSITIVE INTEGER.
            //
            // This endpoint takes `items` straight from the request body and
            // never consults the server-side cart, so the Cart schema's `min: 1`
            // protects nothing here — and `Order.items.quantity` was a bare
            // Number with no floor. A crafted order could therefore carry a
            // NEGATIVE quantity, which flows into
            //   subtotal += price * quantity
            //   tax       = subtotal * gstRate
            //   total     = subtotal + delivery + tax - discount
            // and drags the total to zero or below: pair one real item with a
            // large negative line and you get the food for nothing on COD. A
            // fractional quantity (0.001) does the same thing more quietly.
            // Prices were already server-authoritative; quantity was not.
            const quantity = Number(item.quantity);
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid quantity for ${product.name}. Choose between 1 and ${MAX_ITEM_QUANTITY}.`
                });
            }
            item.quantity = quantity;

            const brand = product.brand || 'teasntrees';
            if (!brandsGrouped[brand]) {
                brandsGrouped[brand] = { items: [], subtotal: 0 };
            }

            const category = product.category ? categoryMap.get(product.category.toString()) : null;
            const hasCakePricing =
                product.cakePricing &&
                product.cakePricing.basePricePerKg !== undefined &&
                product.cakePricing.basePricePerKg !== null;
            const isLittlehCake = brand === 'littleh' && isCakeCategoryName(category?.name || '');

            // Server-authoritative pricing: the client's price is only accepted
            // if it matches a known price point of the product (base price or a
            // size option). Cake items are fully recomputed below regardless.
            let price = product.price ?? 0;
            if (item.price !== undefined && item.price !== null && !isLittlehCake) {
                const clientPrice = Number(item.price);
                const validPrices = [product.price, ...(product.sizeOptions || []).map(o => o.price)]
                    .filter(p => typeof p === 'number');
                if (validPrices.some(p => Math.abs(p - clientPrice) < 0.01)) {
                    price = clientPrice;
                } else {
                    return res.status(400).json({
                        success: false,
                        message: `Price for ${product.name} has changed. Please refresh your cart.`
                    });
                }
            }
            let weight = item.weight;
            let isCustomized = Boolean(item.isCustomized);
            let isEggless = Boolean(item.isEggless);
            let customizationDetails = item.customizationDetails || null;

            if (isLittlehCake) {
                const cakePricing = product.cakePricing || {};
                const customizationEnabled =
                    cakePricing.customizationAvailable === true ||
                    (cakePricing.customizationPricePerKg !== undefined && cakePricing.customizationPricePerKg !== null);
                weight = Number(weight || 1);
                if (!Number.isFinite(weight) || weight <= 0) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid cake weight for ${product.name}`
                    });
                }
                if (isCustomized && !customizationEnabled) {
                    return res.status(400).json({
                        success: false,
                        message: `Customization is not available for ${product.name}`
                    });
                }
                if (isEggless && hasCakePricing && cakePricing.egglessAvailable === false) {
                    return res.status(400).json({
                        success: false,
                        message: `Eggless option is not available for ${product.name}`
                    });
                }

                const perKg = isCustomized
                    ? (cakePricing.customizationPricePerKg ?? cakePricing.basePricePerKg ?? product.price ?? 0)
                    : (cakePricing.basePricePerKg ?? product.price ?? 0);

                price = perKg * weight;
                if (isEggless) {
                    price += (cakePricing.egglessExtraCharge ?? 100);
                }
            }

            brandsGrouped[brand].items.push({
                product: product._id,
                name: product.name,
                quantity: item.quantity,
                price,
                finalPrice: price,
                weight,
                isCustomized,
                isEggless,
                customization: item.customization || '',
                customizationDetails
            });
            brandsGrouped[brand].subtotal += (price * (item.quantity || 0));

            productUpdates.push({
                updateOne: {
                    filter: { _id: product._id },
                    update: { $inc: { orderCount: item.quantity } }
                }
            });
        }

        // Settings are per-brand (unique index on brand) — fetch for every brand
        // in this cart instead of grabbing an arbitrary document.
        const settingsList = await Settings.find({ brand: { $in: Object.keys(brandsGrouped) } }).lean();
        const settingsByBrand = new Map(settingsList.map(s => [s.brand, s]));

        const outlets = await Outlet.find({ isActive: true }).lean();

        // --- COUPON VALIDATION ---
        let globalDiscount = 0;
        let appliedCoupon = null;

        if (couponCode) {
            appliedCoupon = await Coupon.findOne({
                code: couponCode.trim().toUpperCase(),
                isActive: true
            });

            if (!appliedCoupon) {
                return res.status(400).json({ success: false, message: 'Invalid or inactive coupon code' });
            }

            const totalSubtotal = Object.values(brandsGrouped).reduce((sum, g) => sum + g.subtotal, 0);
            const now = new Date();

            // Expiry Check
            if (now > new Date(appliedCoupon.expiryDate)) {
                return res.status(400).json({ success: false, message: 'Coupon has expired' });
            }

            // Min Order Value Check
            if (totalSubtotal < appliedCoupon.minOrderValue) {
                return res.status(400).json({ success: false, message: `Minimum order value of ₹${appliedCoupon.minOrderValue} required for this coupon` });
            }

            // Usage Limit Check (Global)
            if (appliedCoupon.usageLimit !== null && appliedCoupon.usedCount >= appliedCoupon.usageLimit) {
                return res.status(400).json({ success: false, message: 'Coupon usage limit reached' });
            }

            // Per User Limit Check
            if (appliedCoupon.perUserLimit !== null) {
                const userUsage = appliedCoupon.userUsage.find(u => u.userId.toString() === customerId.toString());
                if (userUsage && userUsage.count >= appliedCoupon.perUserLimit) {
                    return res.status(400).json({ success: false, message: 'You have already used this coupon' });
                }
            }

            // First Order Check
            if (appliedCoupon.firstOrderOnly) {
                const previousOrders = await Order.countDocuments({
                    customerId,
                    status: { $nin: ['cancelled'] }
                });
                if (previousOrders > 0) {
                    return res.status(400).json({ success: false, message: 'This coupon is only valid for your first order' });
                }
            }

            // Calculate Discount
            if (appliedCoupon.discountType === 'flat') {
                globalDiscount = Math.min(appliedCoupon.discountAmount, totalSubtotal);
            } else {
                globalDiscount = (totalSubtotal * appliedCoupon.discountAmount) / 100;
                if (appliedCoupon.maxDiscount) {
                    globalDiscount = Math.min(globalDiscount, appliedCoupon.maxDiscount);
                }
            }
            
            globalDiscount = Math.round(globalDiscount * 100) / 100;
            // NOTE: usage is consumed AFTER orders are created, and only if the
            // discount was actually applied to at least one order (see below).
        }

        // Build the order documents first (pure computation, no writes) so the
        // actual persistence can happen atomically inside one transaction.
        const orderDocs = [];
        let grandTotalAllOrders = 0;

        for (const [brand, group] of Object.entries(brandsGrouped)) {
            const outlet = outlets.find(o => o.brand === brand);
            const settings = settingsByBrand.get(brand);
            const deliveryChargePerOrder = settings?.deliveryCharge ?? 50;
            const gstRate = settings?.gstRate || settings?.taxPercentage || 5;
            const tax = Math.round(group.subtotal * (gstRate / 100) * 100) / 100;

            // Apply discount to the first order that can accommodate it
            let orderDiscount = 0;
            if (globalDiscount > 0) {
                // If coupon is brand-specific, only apply if brand matches
                if (!appliedCoupon.brand || appliedCoupon.brand === brand) {
                    orderDiscount = Math.min(globalDiscount, group.subtotal);
                    globalDiscount -= orderDiscount;
                }
            }

            const orderTotal = Math.round((group.subtotal + deliveryChargePerOrder + tax - orderDiscount) * 100) / 100;
            grandTotalAllOrders += orderTotal;

            orderDocs.push({
                customerId,
                brand,
                idempotencyKey: idem.key,
                outletId: outlet ? outlet._id : undefined,
                pickupLocation: outlet ? outlet.location : undefined,
                items: group.items,
                subtotal: group.subtotal,
                deliveryCharge: deliveryChargePerOrder,
                tax,
                couponCode: orderDiscount > 0 ? appliedCoupon.code : null,
                discount: orderDiscount,
                total: orderTotal,
                deliveryAddress: finalDeliveryAddress,
                paymentMethod,
                specialInstructions: deliveryInstructions,
                alternatePhone: altPhone || null,
                status: 'pending'
            });
        }

        const discountApplied = orderDocs.some(o => (o.discount || 0) > 0);

        // Persist all brand-orders and consume the coupon as one atomic unit.
        // A failure part-way (e.g. second brand's order) must not leave a
        // stray first order or a burnt coupon. Atlas (replica set) supports
        // multi-document transactions; we fall back gracefully if unavailable.
        let createdOrders;
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                createdOrders = await Order.create(orderDocs, { session, ordered: true });

                if (appliedCoupon && discountApplied) {
                    // COUPON DOUBLE-SPEND.
                    //
                    // The limit checks above are a READ, taken well before this
                    // WRITE, and the increment used to be unconditional. Fire N
                    // concurrent createOrder calls with the same single-use
                    // coupon and every one of them reads `count: 0`, every one
                    // passes, and every one gets the discount — a "one per
                    // customer" or "first order only" coupon applied N times.
                    // The transaction made the increment atomic; it did nothing
                    // about check-then-act.
                    //
                    // The limit now lives in the update FILTER, so the database
                    // decides, and a loser matches zero documents and aborts the
                    // whole transaction — no order, no discount.
                    //
                    // firstOrderOnly implies at most one use per customer, so it
                    // is enforced here as a per-user limit of 1 rather than
                    // relying on the (equally racy) previous-order count.
                    const globalLimit = appliedCoupon.usageLimit;
                    const perUserLimit = appliedCoupon.firstOrderOnly
                        ? 1
                        : appliedCoupon.perUserLimit;

                    const globalGuard =
                        globalLimit !== null && globalLimit !== undefined
                            ? { usedCount: { $lt: globalLimit } }
                            : {};

                    // Path A: this customer already has a usage entry — bump it,
                    // but only if it is still under their limit.
                    const bumpExisting = await Coupon.updateOne(
                        {
                            _id: appliedCoupon._id,
                            ...globalGuard,
                            userUsage: {
                                $elemMatch: {
                                    userId: customerId,
                                    ...(perUserLimit !== null && perUserLimit !== undefined
                                        ? { count: { $lt: perUserLimit } }
                                        : {})
                                }
                            }
                        },
                        { $inc: { usedCount: 1, 'userUsage.$.count': 1 } },
                        { session }
                    );

                    if (bumpExisting.matchedCount === 0) {
                        // Path B: no entry for this customer yet — create one.
                        // `$ne` guarantees we only take this path when they truly
                        // have none, so a maxed-out customer can't slip through
                        // by failing Path A.
                        const addNew = await Coupon.updateOne(
                            {
                                _id: appliedCoupon._id,
                                ...globalGuard,
                                'userUsage.userId': { $ne: customerId }
                            },
                            {
                                $inc: { usedCount: 1 },
                                $push: { userUsage: { userId: customerId, count: 1 } }
                            },
                            { session }
                        );

                        if (addNew.matchedCount === 0) {
                            // Someone else took the last use, or this customer
                            // already spent theirs, between our check and now.
                            const exhausted = new Error('COUPON_EXHAUSTED');
                            exhausted.code = 'COUPON_EXHAUSTED';
                            throw exhausted;
                        }
                    }
                }
            });
        } catch (err) {
            if (err?.code === 'COUPON_EXHAUSTED') {
                return res.status(400).json({
                    success: false,
                    message: 'That coupon has just been used up. Remove it and try again.'
                });
            }
            throw err;
        } finally {
            await session.endSession();
        }

        // 2. Batch product stats and Dashboard increments
        if (productUpdates.length) {
            Product.bulkWrite(productUpdates).catch((err) => { 
                logger.error('Product stats bulkWrite failed:', err);
            });
        }

        if (createdOrders.length) {
            await statsService.bulkIncrement({
                totalOrders: createdOrders.length,
                pendingOrders: createdOrders.length
            });
        }

        // Socket and Notifications
        const io = req.app.get('io');
        if (io) {
            createdOrders.forEach(order => {
                io.to(SOCKET_ROOMS.user(customerId.toString()))
                    .emit(SOCKET_EVENTS.ORDER_CREATED, {
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        total: order.total
                    });

                // Staff-only event: was a global broadcast, which leaked every
                // order to all connected customers.
                io.to(SOCKET_ROOMS.role('admin')).to(SOCKET_ROOMS.role('manager'))
                    .emit(SOCKET_EVENTS.ORDER_NEW, {
                        orderId: order._id,
                        orderNumber: order.orderNumber,
                        total: order.total,
                        status: order.status,
                        brand: order.brand
                    });
            });
        }

        try {
            const admins = await User.find({ role: { $in: ['admin', 'manager'] } }).select('_id').lean();
            createdOrders.forEach(order => {
                notificationService.sendPushToMany(admins, {
                    title: '🛒 New Order',
                    body: `Order #${order.orderNumber} for ₹${order.total}`,
                    data: { orderId: order._id }
                }).catch(() => { });
            });
        } catch { }

        res.status(201).json({
            success: true,
            data: {
                orderId: createdOrders[0]._id, // legacy
                orderNumber: createdOrders[0].orderNumber,
                orderIds: createdOrders.map(o => o._id),
                orders: createdOrders,
                total: grandTotalAllOrders,
                status: 'pending'
            }
        });

    } catch (error) {
        logger.error('createOrder failed', error);
        res.status(500).json({ success: false, message: 'Failed to create order' });
    }
};

/* =========================================================
   GET MY ORDERS
========================================================= */
export const getMyOrders = async (req, res) => {
    try {
        const customerId = req.user.userId;
        const { page = 1, limit = 10, status, ignoreBrand, excludeStatus } = req.query;

        const query = { customerId };
        if (req.activeBrand && String(ignoreBrand) !== 'true') query.brand = req.activeBrand;
        if (status) query.status = status;
        if (excludeStatus) query.status = { $ne: excludeStatus };

        const skip = (page - 1) * limit;

        const orders = await Order.find(query)
            .populate('items.product', 'name image')
            .populate('riderId', 'name mobile')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit))
            .lean();

        const total = await Order.countDocuments(query);

        res.json({
            success: true,
            data: {
                orders,
                pagination: {
                    page: Number(page),
                    totalPages: Math.ceil(total / limit),
                    total
                }
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch orders' });
    }
};

/* =========================================================
   GET ORDER DETAILS
========================================================= */
export const getOrderById = async (req, res) => {
    try {
        const { orderId } = req.params;
        const customerId = req.user.userId;

        logger.info(`GET ORDER BY ID - orderId: ${orderId}, customerId: ${customerId}, brand: ${req.activeBrand}`);

        const query = { _id: orderId, customerId };

        const order = await Order.findOne(query)
            .populate('items.product', 'name image price')
            .populate('riderId', 'name mobile')
            .lean();

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const delivery = await Delivery.findOne({ orderId: order._id })
            .populate('riderId', 'name mobile')
            .lean();

        const data = { ...order };

        if (delivery) {
            const allowOtp = ['in_transit', 'arrived'].includes(delivery.status);

            data.delivery = {
                status: delivery.status,
                deliveryNumber: delivery.deliveryNumber,
                estimatedTime: delivery.estimatedTime,
                deliveryOtp: allowOtp ? delivery.deliveryOtp : null,
                rider: delivery.riderId
            };
        }

        res.json({ success: true, data });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch order' });
    }
};

/* =========================================================
   CANCEL ORDER (CUSTOMER)
========================================================= */
export const cancelOrder = async (req, res) => {
    try {
        const customerId = req.user.userId;
        const { orderId } = req.params;
        const { reason } = req.body || {};

        const order = await Order.findOne({ _id: orderId, customerId });
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        if (order.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Order can no longer be cancelled'
            });
        }

        order.status = 'cancelled';
        order.cancelReason = reason || 'Cancelled by customer';
        await order.save();

        // Refund the coupon usage this order consumed, so cancelling doesn't
        // permanently burn the customer's use of a limited coupon.
        if (order.couponCode && (order.discount || 0) > 0) {
            await Coupon.updateOne(
                { code: order.couponCode, 'userUsage.userId': customerId },
                {
                    $inc: { usedCount: -1, 'userUsage.$.count': -1 }
                }
            );
        }

        // Cancel delivery ONLY if exists & not picked up
        const delivery = await Delivery.findOne({ orderId: order._id });
        if (delivery && !['picked_up', 'in_transit', 'delivered'].includes(delivery.status)) {
            delivery.status = 'cancelled';
            delivery.cancelledAt = new Date();
            await delivery.save();
        }

        const io = req.app.get('io');
        if (io) {
            // Notify the customer, anyone watching this order, and staff —
            // not every connected socket.
            io.to(SOCKET_ROOMS.user(customerId.toString()))
                .to(SOCKET_ROOMS.order(order._id.toString()))
                .to(SOCKET_ROOMS.role('admin'))
                .to(SOCKET_ROOMS.role('manager'))
                .emit(SOCKET_EVENTS.ORDER_STATUS_UPDATED, {
                    orderId: order._id,
                    status: 'cancelled'
                });
        }

        res.json({
            success: true,
            message: 'Order cancelled',
            data: { orderNumber: order.orderNumber }
        });

    } catch (error) {
        res.status(500).json({ success: false, message: 'Cancel failed' });
    }
};

/* =========================================================
   REORDER
========================================================= */
export const reorder = async (req, res) => {
    try {
        const customerId = req.user.userId;
        const { orderId } = req.params;

        const original = await Order.findOne({ _id: orderId, customerId })
            .populate('items.product')
            .lean();

        if (!original) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        req.body.items = original.items.map(i => ({
            product: i.product?._id || i.product,
            quantity: i.quantity,
            price: i.price,
            weight: i.weight,
            isCustomized: i.isCustomized,
            isEggless: i.isEggless,
            customization: i.customization,
            customizationDetails: i.customizationDetails
        }));

        req.body.deliveryAddress = original.deliveryAddress;
        return createOrder(req, res);

    } catch (error) {
        res.status(500).json({ success: false, message: 'Reorder failed' });
    }
};

/* =========================================================
   DOWNLOAD INVOICE
========================================================= */
export const downloadInvoice = async (req, res) => {
    try {
        const { orderId } = req.params;
        const customerId = req.user.userId;

        const order = await Order.findOne({ _id: orderId, customerId })
            .populate('items.product')
            .populate('customerId', 'name mobile email')
            .lean();

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=invoice-${order.orderNumber}.pdf`);
        doc.pipe(res);

        doc.fontSize(20).text('INVOICE', { align: 'center' });
        doc.moveDown();
        doc.text(`Order: ${order.orderNumber}`);
        doc.text(`Date: ${order.createdAt.toDateString()}`);
        doc.moveDown();

        order.items.forEach(item => {
            doc.text(`${item.name} x${item.quantity} - ₹${item.price * item.quantity}`);
        });

        doc.moveDown();
        doc.text(`Total: ₹${order.total}`, { align: 'right' });
        doc.end();

    } catch (error) {
        res.status(500).json({ success: false, message: 'Invoice generation failed' });
    }
};

/* ==================================================
   RAISE AN ORDER COMPLAINT (after a rider is assigned)
================================================== */
export const createComplaint = async (req, res) => {
    try {
        const { orderId } = req.params;
        const customerId = req.user.userId;
        const { reason, notes } = req.body;

        const validReasons = ['rider_unreachable', 'item_wrong_missing', 'long_delay', 'other'];
        if (!validReasons.includes(reason)) {
            return res.status(400).json({ success: false, message: 'Invalid complaint reason' });
        }

        const order = await Order.findOne({ _id: orderId, customerId }).lean();
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const complaint = await OrderComplaint.create({
            orderId,
            customerId,
            brand: order.brand,
            reason,
            notes: (notes || '').trim()
        });

        // Nudge staff in real time so it can be triaged.
        try {
            const io = req.app.get('io');
            if (io) {
                io.to(SOCKET_ROOMS.role('admin')).to(SOCKET_ROOMS.role('manager'))
                    .emit('order:complaint', {
                        complaintId: complaint._id,
                        orderId,
                        orderNumber: order.orderNumber,
                        reason
                    });
            }
        } catch (emitErr) {
            logger.error('complaint emit failed', emitErr);
        }

        res.status(201).json({
            success: true,
            message: 'Your issue has been reported. Our team will look into it.',
            data: { complaintId: complaint._id, status: complaint.status }
        });
    } catch (error) {
        logger.error('createComplaint error', error);
        res.status(500).json({ success: false, message: 'Could not submit your issue' });
    }
};

/* ==================================================
   EDIT DELIVERY ADDRESS (allowed until the rider picks up)
================================================== */
export const updateOrderAddress = async (req, res) => {
    try {
        const { orderId } = req.params;
        const customerId = req.user.userId;
        const { address, location } = req.body;

        if (!address || !address.trim()) {
            return res.status(400).json({ success: false, message: 'Address is required' });
        }

        const order = await Order.findOne({ _id: orderId, customerId });
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // Lock once the food is on the way — the rider is already routing to the
        // old address past this point. Owner rule: editable until picked_up.
        const locked = ['out-for-delivery', 'in_transit', 'delivered', 'cancelled'];
        if (locked.includes(order.status)) {
            return res.status(409).json({
                success: false,
                message: 'The rider has already picked up your order, so the address can no longer be changed.'
            });
        }

        order.deliveryAddress = order.deliveryAddress || {};
        order.deliveryAddress.address = address.trim();
        if (location && Array.isArray(location.coordinates) && location.coordinates.length === 2) {
            order.deliveryAddress.location = { type: 'Point', coordinates: location.coordinates };
        }
        await order.save();

        // Keep any assigned delivery's drop point in sync.
        if (order.deliveryAddress.location) {
            await Delivery.updateOne(
                { orderId: order._id, status: { $nin: ['delivered', 'cancelled', 'rejected'] } },
                { $set: { deliveryLocation: order.deliveryAddress.location } }
            );
        }

        res.json({
            success: true,
            message: 'Delivery address updated.',
            data: { deliveryAddress: order.deliveryAddress }
        });
    } catch (error) {
        logger.error('updateOrderAddress error', error);
        res.status(500).json({ success: false, message: 'Could not update the address' });
    }
};
