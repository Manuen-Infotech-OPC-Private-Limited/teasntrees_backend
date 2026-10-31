import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import Purchase from '../../models/Purchase.js';
import Expense from '../../models/Expense.js';

// Helper for date filtering
const buildDateFilter = (startDate, endDate, dateField = 'createdAt') => {
    const filter = {};
    if (startDate || endDate) {
        filter[dateField] = {};
        if (startDate) filter[dateField].$gte = new Date(startDate);
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            filter[dateField].$lte = end;
        }
    }
    return filter;
};

// Comprehensive Profit & Loss Report
export const getPnLReport = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        // 1. Sales Aggregations
        const orderDateFilter = buildDateFilter(startDate, endDate, 'createdAt');
        const [salesData] = await Order.aggregate([
            {
                $match: {
                    brand,
                    status: { $nin: ['cancelled'] },
                    ...orderDateFilter
                }
            },
            {
                $group: {
                    _id: null,
                    grossSales: { $sum: { $add: ['$subtotal', '$tax', { $ifNull: ['$deliveryCharge', 0] }] } },
                    netRevenue: { $sum: { $ifNull: ['$total', '$totalAmount', 0] } },
                    discounts: { $sum: { $ifNull: ['$discount', 0] } },
                    taxCollected: { $sum: { $ifNull: ['$tax', 0] } },
                    deliveryFees: { $sum: { $ifNull: ['$deliveryCharge', 0] } },
                    ordersCount: { $sum: 1 }
                }
            }
        ]);

        // 2. Purchases (COGS) Aggregations
        const purchaseDateFilter = buildDateFilter(startDate, endDate, 'invoiceDate');
        const [purchaseData] = await Purchase.aggregate([
            {
                $match: {
                    brand,
                    status: { $ne: 'cancelled' },
                    ...purchaseDateFilter
                }
            },
            {
                $group: {
                    _id: null,
                    totalPurchases: { $sum: '$totalAmount' },
                    purchasesSubtotal: { $sum: '$subtotal' },
                    purchasesTaxPaid: { $sum: '$taxAmount' },
                    purchasesCount: { $sum: 1 }
                }
            }
        ]);

        // 3. Operating Expenses (OPEX)
        const expenseDateFilter = buildDateFilter(startDate, endDate, 'expenseDate');
        const [operatingExpenseData] = await Expense.aggregate([
            {
                $match: {
                    brand,
                    paymentStatus: { $ne: 'cancelled' },
                    ...expenseDateFilter
                }
            },
            {
                $group: {
                    _id: null,
                    totalOperatingExpenses: { $sum: '$amount' },
                    expensesCount: { $sum: 1 }
                }
            }
        ]);

        const netRevenue = salesData ? Number(salesData.netRevenue.toFixed(2)) : 0;
        const grossSales = salesData ? Number(salesData.grossSales.toFixed(2)) : 0;
        const totalDiscounts = salesData ? Number(salesData.discounts.toFixed(2)) : 0;
        const taxCollected = salesData ? Number(salesData.taxCollected.toFixed(2)) : 0;
        const deliveryFees = salesData ? Number(salesData.deliveryFees.toFixed(2)) : 0;
        const ordersCount = salesData ? salesData.ordersCount : 0;

        const totalPurchases = purchaseData ? Number(purchaseData.totalPurchases.toFixed(2)) : 0;
        const purchasesSubtotal = purchaseData ? Number(purchaseData.purchasesSubtotal.toFixed(2)) : 0;
        const purchasesTaxPaid = purchaseData ? Number(purchaseData.purchasesTaxPaid.toFixed(2)) : 0;
        const purchasesCount = purchaseData ? purchaseData.purchasesCount : 0;

        const totalOperatingExpenses = operatingExpenseData ? Number(operatingExpenseData.totalOperatingExpenses.toFixed(2)) : 0;
        const operatingExpensesCount = operatingExpenseData ? operatingExpenseData.expensesCount : 0;

        // P&L Computations
        const grossProfit = Number((netRevenue - totalPurchases).toFixed(2));
        const grossMarginPercent = netRevenue > 0 ? Number(((grossProfit / netRevenue) * 100).toFixed(1)) : 0;
        const netProfit = Number((grossProfit - totalOperatingExpenses).toFixed(2));
        const netMarginPercent = netRevenue > 0 ? Number(((netProfit / netRevenue) * 100).toFixed(1)) : 0;

        res.status(200).json({
            success: true,
            data: {
                revenue: {
                    grossSales,
                    netRevenue,
                    totalDiscounts,
                    deliveryFees,
                    ordersCount
                },
                expenses: {
                    costOfGoodsPurchased: totalPurchases,
                    purchasesSubtotal,
                    purchasesCount,
                    operatingExpenses: totalOperatingExpenses,
                    operatingExpensesCount,
                    totalExpenses: Number((totalPurchases + totalOperatingExpenses).toFixed(2))
                },
                profitability: {
                    grossProfit,
                    grossMarginPercent,
                    netProfit,
                    netMarginPercent
                },
                taxes: {
                    outputGstCollected: taxCollected,
                    inputGstPaid: purchasesTaxPaid,
                    netGstLiability: Number((taxCollected - purchasesTaxPaid).toFixed(2))
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GST / Tax Report
export const getTaxReport = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const orderDateFilter = buildDateFilter(startDate, endDate, 'createdAt');
        const [salesTax] = await Order.aggregate([
            { $match: { brand, status: { $nin: ['cancelled'] }, ...orderDateFilter } },
            {
                $group: {
                    _id: null,
                    taxableSales: { $sum: '$subtotal' },
                    outputTaxCollected: { $sum: { $ifNull: ['$tax', 0] } }
                }
            }
        ]);

        const purchaseDateFilter = buildDateFilter(startDate, endDate, 'invoiceDate');
        const [purchaseTax] = await Purchase.aggregate([
            { $match: { brand, status: { $ne: 'cancelled' }, ...purchaseDateFilter } },
            {
                $group: {
                    _id: null,
                    taxablePurchases: { $sum: '$subtotal' },
                    inputTaxCredit: { $sum: '$taxAmount' }
                }
            }
        ]);

        const taxableSales = salesTax ? Number(salesTax.taxableSales.toFixed(2)) : 0;
        const outputTax = salesTax ? Number(salesTax.outputTaxCollected.toFixed(2)) : 0;
        const taxablePurchases = purchaseTax ? Number(purchaseTax.taxablePurchases.toFixed(2)) : 0;
        const inputTax = purchaseTax ? Number(purchaseTax.inputTaxCredit.toFixed(2)) : 0;
        const netGstLiability = Number((outputTax - inputTax).toFixed(2));

        res.status(200).json({
            success: true,
            data: {
                taxableSales,
                outputTax,
                taxablePurchases,
                inputTax,
                netGstLiability
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Vendor procurement spend analysis
export const getProcurementReport = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const matchFilter = {
            brand,
            status: { $ne: 'cancelled' },
            ...buildDateFilter(startDate, endDate, 'invoiceDate')
        };

        const vendorSpend = await Purchase.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: '$vendor',
                    totalSpend: { $sum: '$totalAmount' },
                    totalPaid: { $sum: '$paidAmount' },
                    balanceDue: { $sum: '$balanceAmount' },
                    invoicesCount: { $sum: 1 }
                }
            },
            {
                $lookup: {
                    from: 'vendors',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'vendorDetails'
                }
            },
            { $unwind: '$vendorDetails' },
            { $sort: { totalSpend: -1 } },
            {
                $project: {
                    vendorId: '$_id',
                    vendorName: '$vendorDetails.companyName',
                    contactPerson: '$vendorDetails.name',
                    category: '$vendorDetails.category',
                    phone: '$vendorDetails.phone',
                    gstin: '$vendorDetails.gstin',
                    totalSpend: { $round: ['$totalSpend', 2] },
                    totalPaid: { $round: ['$totalPaid', 2] },
                    balanceDue: { $round: ['$balanceDue', 2] },
                    invoicesCount: 1,
                    _id: 0
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: vendorSpend
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Periodic P&L timeline trends (sales revenue vs procurement costs)
export const getReportTrends = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate, groupBy = 'day' } = req.query;

        const matchSales = {
            brand,
            status: { $nin: ['cancelled'] },
            ...buildDateFilter(startDate, endDate, 'createdAt')
        };
        const matchPurchases = {
            brand,
            status: { $ne: 'cancelled' },
            ...buildDateFilter(startDate, endDate, 'invoiceDate')
        };
        const matchExpenses = {
            brand,
            paymentStatus: { $ne: 'cancelled' },
            ...buildDateFilter(startDate, endDate, 'expenseDate')
        };

        const dateFormat = groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';

        // 1. Sales timeline
        const salesTrends = await Order.aggregate([
            { $match: matchSales },
            {
                $group: {
                    _id: { $dateToString: { format: dateFormat, date: '$createdAt', timezone: '+05:30' } },
                    netSales: { $sum: { $ifNull: ['$total', '$totalAmount', 0] } },
                    orders: { $sum: 1 }
                }
            }
        ]);

        // 2. Purchases (COGS) timeline
        const purchaseTrends = await Purchase.aggregate([
            { $match: matchPurchases },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: dateFormat,
                            date: { $ifNull: ['$invoiceDate', '$createdAt'] },
                            timezone: '+05:30'
                        }
                    },
                    procurementCost: { $sum: '$totalAmount' },
                    purchases: { $sum: 1 }
                }
            }
        ]);

        // 3. Operating Expenses (OPEX) timeline
        const expenseTrends = await Expense.aggregate([
            { $match: matchExpenses },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format: dateFormat,
                            date: { $ifNull: ['$expenseDate', '$createdAt'] },
                            timezone: '+05:30'
                        }
                    },
                    operatingExpenses: { $sum: '$amount' },
                    expenses: { $sum: 1 }
                }
            }
        ]);

        // Merge all into timeline
        const map = new Map();
        salesTrends.forEach(s => {
            if (!s._id) return;
            map.set(s._id, {
                date: s._id,
                sales: Number(s.netSales.toFixed(2)),
                procurement: 0,
                operatingExpenses: 0,
                profit: Number(s.netSales.toFixed(2)),
                orders: s.orders,
                purchases: 0,
                expenses: 0
            });
        });

        purchaseTrends.forEach(p => {
            if (!p._id) return;
            const existing = map.get(p._id) || {
                date: p._id,
                sales: 0,
                procurement: 0,
                operatingExpenses: 0,
                profit: 0,
                orders: 0,
                purchases: 0,
                expenses: 0
            };
            existing.procurement = Number(p.procurementCost.toFixed(2));
            existing.profit = Number((existing.sales - existing.procurement - existing.operatingExpenses).toFixed(2));
            existing.purchases = p.purchases;
            map.set(p._id, existing);
        });

        expenseTrends.forEach(e => {
            if (!e._id) return;
            const existing = map.get(e._id) || {
                date: e._id,
                sales: 0,
                procurement: 0,
                operatingExpenses: 0,
                profit: 0,
                orders: 0,
                purchases: 0,
                expenses: 0
            };
            existing.operatingExpenses = Number(e.operatingExpenses.toFixed(2));
            existing.profit = Number((existing.sales - existing.procurement - existing.operatingExpenses).toFixed(2));
            existing.expenses = e.expenses;
            map.set(e._id, existing);
        });

        const timeline = Array.from(map.values())
            .filter(item => Boolean(item.date))
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        res.status(200).json({
            success: true,
            data: timeline
        });
    } catch (error) {
        console.error('Error fetching report trends:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Operating Expenses by Category Breakdown for Charts
export const getExpenseCategoryReport = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const matchFilter = {
            brand,
            paymentStatus: { $ne: 'cancelled' },
            ...buildDateFilter(startDate, endDate, 'expenseDate')
        };

        const categorySpend = await Expense.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: '$category',
                    totalSpend: { $sum: '$amount' },
                    expensesCount: { $sum: 1 }
                }
            },
            { $sort: { totalSpend: -1 } },
            {
                $project: {
                    category: '$_id',
                    totalSpend: { $round: ['$totalSpend', 2] },
                    expensesCount: 1,
                    _id: 0
                }
            }
        ]);

        res.status(200).json({
            success: true,
            data: categorySpend
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Export P&L Report as CSV
export const exportPnLCSV = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { startDate, endDate } = req.query;

        const orderDateFilter = buildDateFilter(startDate, endDate, 'createdAt');
        const [salesData] = await Order.aggregate([
            { $match: { brand, status: { $nin: ['cancelled'] }, ...orderDateFilter } },
            {
                $group: {
                    _id: null,
                    grossSales: { $sum: { $add: ['$subtotal', '$tax', { $ifNull: ['$deliveryCharge', 0] }] } },
                    netRevenue: { $sum: { $ifNull: ['$total', '$totalAmount', 0] } },
                    discounts: { $sum: { $ifNull: ['$discount', 0] } },
                    tax: { $sum: { $ifNull: ['$tax', 0] } }
                }
            }
        ]);

        const purchaseDateFilter = buildDateFilter(startDate, endDate, 'invoiceDate');
        const [purchaseData] = await Purchase.aggregate([
            { $match: { brand, status: { $ne: 'cancelled' }, ...purchaseDateFilter } },
            {
                $group: {
                    _id: null,
                    totalPurchases: { $sum: '$totalAmount' },
                    taxPaid: { $sum: '$taxAmount' }
                }
            }
        ]);

        const netRev = salesData?.netRevenue || 0;
        const purchases = purchaseData?.totalPurchases || 0;
        const grossProfit = netRev - purchases;
        const margin = netRev > 0 ? ((grossProfit / netRev) * 100).toFixed(1) : '0.0';

        let csv = 'METRIC,AMOUNT (INR)\r\n';
        csv += `Gross Sales Revenue,${(salesData?.grossSales || 0).toFixed(2)}\r\n`;
        csv += `Customer Discounts Given,${(salesData?.discounts || 0).toFixed(2)}\r\n`;
        csv += `Net Sales Revenue,${netRev.toFixed(2)}\r\n`;
        csv += `Raw Material Purchases (COGS),${purchases.toFixed(2)}\r\n`;
        csv += `Gross Profit / Margin,${grossProfit.toFixed(2)}\r\n`;
        csv += `Gross Margin Percentage,${margin}%\r\n`;
        csv += `Output GST Collected (Sales),${(salesData?.tax || 0).toFixed(2)}\r\n`;
        csv += `Input GST Credit (Purchases),${(purchaseData?.taxPaid || 0).toFixed(2)}\r\n`;
        csv += `Net GST Liability,${((salesData?.tax || 0) - (purchaseData?.taxPaid || 0)).toFixed(2)}\r\n`;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=pnl-report-${brand}-${Date.now()}.csv`);
        res.status(200).send(csv);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

