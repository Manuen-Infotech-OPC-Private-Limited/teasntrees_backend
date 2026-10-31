import mongoose from 'mongoose';
import Vendor, { TNT_VENDOR_CATEGORIES, LITTLEH_VENDOR_CATEGORIES, VENDOR_CATEGORY_LABELS } from '../../models/Vendor.js';
import Purchase from '../../models/Purchase.js';

// Get available categories for current brand
export const getVendorCategories = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const categories = brand === 'littleh' ? LITTLEH_VENDOR_CATEGORIES : TNT_VENDOR_CATEGORIES;
        const labels = VENDOR_CATEGORY_LABELS[brand] || VENDOR_CATEGORY_LABELS.teasntrees;

        const categoryOptions = categories.map(key => ({
            value: key,
            label: labels[key] || key
        }));

        res.status(200).json({
            success: true,
            brand,
            data: categoryOptions
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get all vendors with filters & purchase stats
export const getVendors = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { search, category, isActive, page = 1, limit = 20 } = req.query;

        const filter = {
            brand: { $in: [brand, 'both'] }
        };

        if (search) {
            filter.$or = [
                { companyName: { $regex: search, $options: 'i' } },
                { name: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { gstin: { $regex: search, $options: 'i' } }
            ];
        }

        if (category && category !== 'all') {
            filter.category = category;
        }

        if (isActive !== undefined && isActive !== 'all') {
            filter.isActive = isActive === 'true';
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await Vendor.countDocuments(filter);

        const vendors = await Vendor.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Enrich with purchase aggregations (total purchases & outstanding balance)
        const vendorIds = vendors.map(v => v._id);
        const purchaseAgg = await Purchase.aggregate([
            { $match: { vendor: { $in: vendorIds }, brand, status: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: '$vendor',
                    totalPurchases: { $sum: 1 },
                    totalAmount: { $sum: '$totalAmount' },
                    totalBalance: { $sum: '$balanceAmount' }
                }
            }
        ]);

        const statsMap = new Map();
        purchaseAgg.forEach(p => {
            statsMap.set(p._id.toString(), {
                totalPurchases: p.totalPurchases,
                totalAmount: Number(p.totalAmount.toFixed(2)),
                totalBalance: Number(p.totalBalance.toFixed(2))
            });
        });

        const enrichedVendors = vendors.map(v => ({
            ...v,
            stats: statsMap.get(v._id.toString()) || { totalPurchases: 0, totalAmount: 0, totalBalance: 0 }
        }));

        res.status(200).json({
            success: true,
            data: enrichedVendors,
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

// Get single vendor by ID with purchase history
export const getVendorById = async (req, res) => {
    try {
        const { id } = req.params;
        const brand = req.activeBrand || req.params.brand || 'teasntrees';

        const vendor = await Vendor.findById(id).lean();
        if (!vendor) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        const recentPurchases = await Purchase.find({ vendor: id, brand })
            .sort({ invoiceDate: -1 })
            .limit(10)
            .lean();

        const [totals] = await Purchase.aggregate([
            { $match: { vendor: new mongoose.Types.ObjectId(id), brand, status: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: null,
                    totalPurchases: { $sum: 1 },
                    totalAmount: { $sum: '$totalAmount' },
                    paidAmount: { $sum: '$paidAmount' },
                    balanceAmount: { $sum: '$balanceAmount' }
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: {
                ...vendor,
                recentPurchases,
                summary: totals || { totalPurchases: 0, totalAmount: 0, paidAmount: 0, balanceAmount: 0 }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Create vendor
export const createVendor = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const vendorData = {
            ...req.body,
            brand: req.body.brand || brand
        };

        const vendor = new Vendor(vendorData);
        await vendor.save();

        res.status(201).json({
            success: true,
            message: 'Vendor created successfully',
            data: vendor
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// Update vendor
export const updateVendor = async (req, res) => {
    try {
        const { id } = req.params;
        const vendor = await Vendor.findByIdAndUpdate(id, req.body, {
            new: true,
            runValidators: true
        });

        if (!vendor) {
            return res.status(404).json({ success: false, message: 'Vendor not found' });
        }

        res.status(200).json({
            success: true,
            message: 'Vendor updated successfully',
            data: vendor
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// Delete or toggle active status of vendor
export const deleteVendor = async (req, res) => {
    try {
        const { id } = req.params;
        const purchaseCount = await Purchase.countDocuments({ vendor: id });

        if (purchaseCount > 0) {
            // Soft delete / deactivate if linked purchases exist
            const vendor = await Vendor.findByIdAndUpdate(id, { isActive: false }, { new: true });
            return res.status(200).json({
                success: true,
                message: 'Vendor has existing purchase history; marked as inactive instead of deleting.',
                data: vendor
            });
        }

        await Vendor.findByIdAndDelete(id);
        res.status(200).json({
            success: true,
            message: 'Vendor deleted successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Vendor KPI overview stats
export const getVendorStats = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const filter = { brand: { $in: [brand, 'both'] } };

        const [totalVendors, activeVendors] = await Promise.all([
            Vendor.countDocuments(filter),
            Vendor.countDocuments({ ...filter, isActive: true })
        ]);

        const [purchaseSummary] = await Purchase.aggregate([
            { $match: { brand, status: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: null,
                    totalOutstanding: { $sum: '$balanceAmount' },
                    totalProcurement: { $sum: '$totalAmount' }
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: {
                totalVendors,
                activeVendors,
                totalOutstanding: purchaseSummary ? Number(purchaseSummary.totalOutstanding.toFixed(2)) : 0,
                totalProcurement: purchaseSummary ? Number(purchaseSummary.totalProcurement.toFixed(2)) : 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

