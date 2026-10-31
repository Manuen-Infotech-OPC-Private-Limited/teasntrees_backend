import mongoose from 'mongoose';
import Purchase from '../../models/Purchase.js';
import Vendor from '../../models/Vendor.js';

// Generate sequential or timestamped purchase number
const generatePurchaseNumber = async (brand) => {
    const prefix = brand === 'littleh' ? 'PUR-LTL' : 'PUR-TNT';
    const dateStr = new Date().toISOString().slice(2, 7).replace('-', '');
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${dateStr}-${random}`;
};

// Calculate line items and totals
const computePurchaseTotals = (items = [], initialPaid = 0) => {
    let subtotal = 0;
    let taxAmount = 0;

    const computedItems = items.map(item => {
        const qty = Number(item.quantity) || 0;
        const price = Number(item.unitPrice) || 0;
        const lineBase = Number((qty * price).toFixed(2));
        const rate = Number(item.taxRate) || 0;
        const lineTax = Number(((lineBase * rate) / 100).toFixed(2));
        const lineTotal = Number((lineBase + lineTax).toFixed(2));

        subtotal += lineBase;
        taxAmount += lineTax;

        return {
            ...item,
            quantity: qty,
            unitPrice: price,
            taxRate: rate,
            taxAmount: lineTax,
            totalPrice: lineTotal
        };
    });

    subtotal = Number(subtotal.toFixed(2));
    taxAmount = Number(taxAmount.toFixed(2));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));
    const paidAmount = Number((Number(initialPaid) || 0).toFixed(2));
    const balanceAmount = Math.max(0, Number((totalAmount - paidAmount).toFixed(2)));

    let paymentStatus = 'pending';
    if (balanceAmount <= 0 && totalAmount > 0) {
        paymentStatus = 'paid';
    } else if (paidAmount > 0 && balanceAmount > 0) {
        paymentStatus = 'partial';
    }

    return {
        items: computedItems,
        subtotal,
        taxAmount,
        totalAmount,
        paidAmount,
        balanceAmount,
        paymentStatus
    };
};

// Get all purchases with filters
export const getPurchases = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const {
            vendor,
            paymentStatus,
            status,
            startDate,
            endDate,
            search,
            page = 1,
            limit = 20
        } = req.query;

        const filter = { brand };

        if (vendor && vendor !== 'all') {
            filter.vendor = vendor;
        }

        if (paymentStatus && paymentStatus !== 'all') {
            filter.paymentStatus = paymentStatus;
        }

        if (status && status !== 'all') {
            filter.status = status;
        }

        if (startDate || endDate) {
            filter.invoiceDate = {};
            if (startDate) filter.invoiceDate.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                filter.invoiceDate.$lte = end;
            }
        }

        if (search) {
            filter.$or = [
                { purchaseNumber: { $regex: search, $options: 'i' } },
                { invoiceNumber: { $regex: search, $options: 'i' } },
                { 'items.name': { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await Purchase.countDocuments(filter);

        const purchases = await Purchase.find(filter)
            .populate('vendor', 'companyName name phone gstin category')
            .sort({ invoiceDate: -1, createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        res.status(200).json({
            success: true,
            data: purchases,
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

// Get single purchase by ID
export const getPurchaseById = async (req, res) => {
    try {
        const { id } = req.params;
        const purchase = await Purchase.findById(id)
            .populate('vendor')
            .populate('createdBy', 'name email');

        if (!purchase) {
            return res.status(404).json({ success: false, message: 'Purchase record not found' });
        }

        res.status(200).json({
            success: true,
            data: purchase
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Create new purchase
export const createPurchase = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { vendor, invoiceNumber, invoiceDate, deliveryDate, items, paidAmount, paymentMethod, invoiceDocument, notes } = req.body;

        if (!vendor) {
            return res.status(400).json({ success: false, message: 'Vendor is required' });
        }

        if (!mongoose.Types.ObjectId.isValid(vendor)) {
            return res.status(400).json({ success: false, message: 'Invalid vendor ID format' });
        }

        if (!items || !items.length) {
            return res.status(400).json({ success: false, message: 'At least one line item is required' });
        }

        const vendorDoc = await Vendor.findById(vendor);
        if (!vendorDoc) {
            return res.status(404).json({ success: false, message: 'Selected vendor does not exist' });
        }

        const purchaseNumber = await generatePurchaseNumber(brand);
        const totals = computePurchaseTotals(items, paidAmount || 0);

        const payments = [];
        if (totals.paidAmount > 0) {
            payments.push({
                amount: totals.paidAmount,
                paidAt: new Date(),
                method: paymentMethod || 'bank_transfer',
                notes: 'Initial payment recorded on bill creation'
            });
        }

        const parsedInvoiceDate = invoiceDate ? new Date(invoiceDate) : new Date();
        const parsedDeliveryDate = (deliveryDate && deliveryDate !== '') ? new Date(deliveryDate) : null;

        const purchase = new Purchase({
            purchaseNumber,
            brand,
            vendor,
            invoiceNumber: (invoiceNumber || '').trim(),
            invoiceDate: isNaN(parsedInvoiceDate.getTime()) ? new Date() : parsedInvoiceDate,
            deliveryDate: (parsedDeliveryDate && !isNaN(parsedDeliveryDate.getTime())) ? parsedDeliveryDate : null,
            items: totals.items,
            subtotal: totals.subtotal,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            paidAmount: totals.paidAmount,
            balanceAmount: totals.balanceAmount,
            paymentStatus: totals.paymentStatus,
            paymentMethod: paymentMethod || 'bank_transfer',
            payments,
            status: req.body.status || 'received',
            invoiceDocument: (invoiceDocument && invoiceDocument !== '') ? invoiceDocument : null,
            notes: notes || '',
            createdBy: req.user ? req.user._id : null
        });

        await purchase.save();

        res.status(201).json({
            success: true,
            message: 'Purchase created successfully',
            data: purchase
        });
    } catch (error) {
        console.error('Error creating purchase:', error);
        res.status(400).json({ success: false, message: error.message });
    }
};

// Update purchase
export const updatePurchase = async (req, res) => {
    try {
        const { id } = req.params;
        const purchase = await Purchase.findById(id);

        if (!purchase) {
            return res.status(404).json({ success: false, message: 'Purchase not found' });
        }

        const { items, paidAmount, ...rest } = req.body;
        let updateData = { ...rest };

        if (updateData.deliveryDate === '') updateData.deliveryDate = null;
        if (updateData.invoiceDocument === '') updateData.invoiceDocument = null;
        if (updateData.deliveryDate) {
            const d = new Date(updateData.deliveryDate);
            updateData.deliveryDate = isNaN(d.getTime()) ? null : d;
        }

        if (items) {
            const currentPaid = paidAmount !== undefined ? Number(paidAmount) : purchase.paidAmount;
            const totals = computePurchaseTotals(items, currentPaid);
            updateData = {
                ...updateData,
                ...totals
            };
        } else if (paidAmount !== undefined) {
            const newPaid = Number(paidAmount);
            const balance = Math.max(0, Number((purchase.totalAmount - newPaid).toFixed(2)));
            let paymentStatus = 'pending';
            if (balance <= 0 && purchase.totalAmount > 0) {
                paymentStatus = 'paid';
            } else if (newPaid > 0 && balance > 0) {
                paymentStatus = 'partial';
            }
            updateData.paidAmount = newPaid;
            updateData.balanceAmount = balance;
            updateData.paymentStatus = paymentStatus;
        }

        Object.assign(purchase, updateData);
        await purchase.save();

        res.status(200).json({
            success: true,
            message: 'Purchase updated successfully',
            data: purchase
        });
    } catch (error) {
        console.error('Error updating purchase:', error);
        res.status(400).json({ success: false, message: error.message });
    }
};

// Record payment installment on purchase
export const recordPurchasePayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { amount, method, transactionRef, notes, paidAt } = req.body;

        const payAmount = Number(amount);
        if (!payAmount || payAmount <= 0) {
            return res.status(400).json({ success: false, message: 'A valid payment amount is required' });
        }

        const purchase = await Purchase.findById(id);
        if (!purchase) {
            return res.status(404).json({ success: false, message: 'Purchase not found' });
        }

        purchase.payments.push({
            amount: payAmount,
            paidAt: paidAt || new Date(),
            method: method || 'bank_transfer',
            transactionRef: transactionRef || '',
            notes: notes || ''
        });

        purchase.paidAmount = Number(((purchase.paidAmount || 0) + payAmount).toFixed(2));
        purchase.balanceAmount = Math.max(0, Number((purchase.totalAmount - purchase.paidAmount).toFixed(2)));

        if (purchase.balanceAmount <= 0 && purchase.totalAmount > 0) {
            purchase.paymentStatus = 'paid';
        } else {
            purchase.paymentStatus = 'partial';
        }

        await purchase.save();

        res.status(200).json({
            success: true,
            message: `Payment of ₹${payAmount} recorded successfully`,
            data: purchase
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete or cancel purchase
export const deletePurchase = async (req, res) => {
    try {
        const { id } = req.params;
        const purchase = await Purchase.findById(id);

        if (!purchase) {
            return res.status(404).json({ success: false, message: 'Purchase not found' });
        }

        // If payments were already logged, mark as cancelled instead of hard deleting
        if (purchase.paidAmount > 0) {
            purchase.status = 'cancelled';
            await purchase.save();
            return res.status(200).json({
                success: true,
                message: 'Purchase had recorded payments; marked as cancelled.',
                data: purchase
            });
        }

        await Purchase.findByIdAndDelete(id);
        res.status(200).json({
            success: true,
            message: 'Purchase deleted successfully'
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Purchase Overview KPIs
export const getPurchaseStats = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';

        const [summary] = await Purchase.aggregate([
            { $match: { brand, status: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: null,
                    totalPurchasesCount: { $sum: 1 },
                    totalSpend: { $sum: '$totalAmount' },
                    totalPaid: { $sum: '$paidAmount' },
                    totalBalance: { $sum: '$balanceAmount' },
                    totalTax: { $sum: '$taxAmount' }
                }
            }
        ]);

        const pendingCount = await Purchase.countDocuments({
            brand,
            status: { $ne: 'cancelled' },
            paymentStatus: { $in: ['pending', 'partial'] }
        });

        res.status(200).json({
            success: true,
            data: {
                totalPurchasesCount: summary ? summary.totalPurchasesCount : 0,
                totalSpend: summary ? Number(summary.totalSpend.toFixed(2)) : 0,
                totalPaid: summary ? Number(summary.totalPaid.toFixed(2)) : 0,
                totalBalance: summary ? Number(summary.totalBalance.toFixed(2)) : 0,
                totalTax: summary ? Number(summary.totalTax.toFixed(2)) : 0,
                pendingInvoicesCount: pendingCount
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

