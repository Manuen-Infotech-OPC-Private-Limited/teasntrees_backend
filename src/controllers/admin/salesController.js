import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import User from '../../models/User.js';

// Helper for date filter
const getDateFilter = (startDate, endDate) => {
    const filter = {};
    if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            filter.createdAt.$lte = end;
        }
    }
    return filter;
};

// Sales KPI Overview
export const getSalesSummary = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const matchFilter = {
            brand,
            status: { $nin: ['cancelled'] },
            ...getDateFilter(startDate, endDate)
        };

        const [metrics] = await Order.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: null,
                    totalOrders: { $sum: 1 },
                    grossSales: { $sum: { $add: [{ $ifNull: ['$subtotal', 0] }, { $ifNull: ['$tax', 0] }, { $ifNull: ['$deliveryCharge', 0] }] } },
                    netSales: { $sum: { $ifNull: ['$total', '$totalAmount', 0] } },
                    totalDiscount: { $sum: { $ifNull: ['$discount', 0] } },
                    totalTax: { $sum: { $ifNull: ['$tax', 0] } },
                    totalDeliveryFee: { $sum: { $ifNull: ['$deliveryCharge', 0] } }
                }
            }
        ]);

        const totalDelivered = await Order.countDocuments({
            brand,
            status: 'delivered',
            ...getDateFilter(startDate, endDate)
        });

        const totalCancelled = await Order.countDocuments({
            brand,
            status: 'cancelled',
            ...getDateFilter(startDate, endDate)
        });

        const totalOrders = metrics ? metrics.totalOrders : 0;
        const netSales = metrics ? Number(metrics.netSales.toFixed(2)) : 0;
        const grossSales = metrics ? Number(metrics.grossSales.toFixed(2)) : 0;
        const totalDiscount = metrics ? Number(metrics.totalDiscount.toFixed(2)) : 0;
        const totalTax = metrics ? Number(metrics.totalTax.toFixed(2)) : 0;
        const totalDeliveryFee = metrics ? Number(metrics.totalDeliveryFee.toFixed(2)) : 0;
        const aov = totalOrders > 0 ? Number((netSales / totalOrders).toFixed(2)) : 0;

        res.status(200).json({
            success: true,
            data: {
                totalOrders,
                totalDelivered,
                totalCancelled,
                grossSales,
                netSales,
                totalDiscount,
                totalTax,
                totalDeliveryFee,
                averageOrderValue: aov
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Sales timeline trends (daily/monthly for Recharts)
export const getSalesTrends = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate, groupBy = 'day' } = req.query;

        // Default to last 30 days if no date range specified
        let start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        let end = endDate ? new Date(endDate) : new Date();
        end.setHours(23, 59, 59, 999);

        const matchFilter = {
            brand,
            status: { $nin: ['cancelled'] },
            createdAt: { $gte: start, $lte: end }
        };

        const dateFormat = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

        const trends = await Order.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
                    netSales: { $sum: { $ifNull: ['$total', '$totalAmount', 0] } },
                    orders: { $sum: 1 },
                    tax: { $sum: { $ifNull: ['$tax', 0] } },
                    discount: { $sum: { $ifNull: ['$discount', 0] } }
                }
            },
            { $sort: { _id: 1 } },
            {
                $project: {
                    date: '$_id',
                    netSales: { $round: ['$netSales', 2] },
                    orders: 1,
                    tax: { $round: ['$tax', 2] },
                    discount: { $round: ['$discount', 2] },
                    _id: 0
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: trends
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Sales breakdown by payment method & order channels
export const getSalesBreakdown = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const matchFilter = {
            brand,
            status: { $nin: ['cancelled'] },
            ...getDateFilter(startDate, endDate)
        };

        const paymentBreakdown = await Order.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: '$paymentMethod',
                    totalSales: { $sum: { $ifNull: ['$total', '$totalAmount', 0] } },
                    ordersCount: { $sum: 1 }
                }
            },
            {
                $project: {
                    method: { $ifNull: ['$_id', 'Unknown'] },
                    totalSales: { $round: ['$totalSales', 2] },
                    ordersCount: 1,
                    _id: 0
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: {
                paymentBreakdown
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Top Selling Menu Items
export const getTopProducts = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate, limit = 10 } = req.query;

        const matchFilter = {
            brand,
            status: { $nin: ['cancelled'] },
            ...getDateFilter(startDate, endDate)
        };

        const topItems = await Order.aggregate([
            { $match: matchFilter },
            { $unwind: '$items' },
            {
                $group: {
                    _id: '$items.name',
                    productId: { $first: '$items.product' },
                    quantitySold: { $sum: '$items.quantity' },
                    revenue: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.finalPrice', '$items.price'] }] } }
                }
            },
            { $sort: { revenue: -1 } },
            { $limit: parseInt(limit) },
            {
                $project: {
                    name: '$_id',
                    productId: 1,
                    quantitySold: 1,
                    revenue: { $round: ['$revenue', 2] },
                    _id: 0
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: topItems
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Paginated sales transactions
export const getSalesOrders = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const {
            page = 1,
            limit = 20,
            search,
            paymentMethod,
            paymentStatus,
            status,
            startDate,
            endDate
        } = req.query;

        const filter = {
            brand,
            ...getDateFilter(startDate, endDate)
        };

        if (paymentMethod && paymentMethod !== 'all') {
            filter.paymentMethod = paymentMethod;
        }

        if (paymentStatus && paymentStatus !== 'all') {
            filter.paymentStatus = paymentStatus;
        }

        if (status && status !== 'all') {
            filter.status = status;
        }

        if (search) {
            const matchedUsers = await User.find({
                $or: [
                    { name: { $regex: search, $options: 'i' } },
                    { mobile: { $regex: search, $options: 'i' } }
                ]
            }).select('_id').lean();
            const matchedUserIds = matchedUsers.map(u => u._id);

            filter.$or = [
                { orderNumber: { $regex: search, $options: 'i' } },
                { customerId: { $in: matchedUserIds } },
                { 'items.name': { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await Order.countDocuments(filter);

        const orders = await Order.find(filter)
            .select('orderNumber createdAt total totalAmount subtotal tax discount deliveryCharge paymentMethod paymentStatus status items customerId alternatePhone')
            .populate('customerId', 'name mobile email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const formattedOrders = orders.map(o => ({
            ...o,
            total: o.total !== undefined ? o.total : (o.totalAmount || 0),
            totalAmount: o.total !== undefined ? o.total : (o.totalAmount || 0),
            customer: {
                name: o.customerId?.name || 'Guest Customer',
                phone: o.customerId?.mobile || o.alternatePhone || 'N/A',
                email: o.customerId?.email || ''
            }
        }));

        res.status(200).json({
            success: true,
            data: formattedOrders,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Export Sales CSV
export const exportSalesCSV = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const matchFilter = {
            brand,
            ...getDateFilter(startDate, endDate)
        };

        const orders = await Order.find(matchFilter)
            .select('orderNumber createdAt total totalAmount subtotal tax discount deliveryCharge paymentMethod paymentStatus status customerId alternatePhone items')
            .populate('customerId', 'name mobile email')
            .sort({ createdAt: -1 })
            .lean();

        let csv = 'Order ID,Date,Customer Name,Customer Phone,Items Count,Subtotal (INR),Discount (INR),Tax (INR),Delivery (INR),Total (INR),Payment Method,Payment Status,Order Status\r\n';

        orders.forEach(o => {
            const dateStr = new Date(o.createdAt).toLocaleDateString('en-IN');
            const custName = (o.customerId?.name || 'Guest Customer').replace(/,/g, ' ');
            const custPhone = o.customerId?.mobile || o.alternatePhone || 'N/A';
            const itemsCount = (o.items || []).reduce((acc, it) => acc + (it.quantity || 1), 0);
            const subtotal = (o.subtotal || 0).toFixed(2);
            const discount = (o.discount || 0).toFixed(2);
            const tax = (o.tax || 0).toFixed(2);
            const delivery = (o.deliveryCharge || 0).toFixed(2);
            const total = (o.total !== undefined ? o.total : (o.totalAmount || 0)).toFixed(2);
            const method = o.paymentMethod || 'N/A';
            const payStatus = o.paymentStatus || 'N/A';
            const status = o.status || 'N/A';

            csv += `"${o.orderNumber}","${dateStr}","${custName}","${custPhone}",${itemsCount},${subtotal},${discount},${tax},${delivery},${total},"${method}","${payStatus}","${status}"\r\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=sales-report-${brand}-${Date.now()}.csv`);
        res.status(200).send(csv);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

