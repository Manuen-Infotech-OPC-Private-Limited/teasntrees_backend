import Expense from '../../models/Expense.js';

// Helper to generate unique human-readable expense number
const generateExpenseNumber = async (brand) => {
    const prefix = brand === 'littleh' ? 'EXP-LTL' : 'EXP-TNT';
    const dateStr = new Date().toISOString().slice(2, 7).replace('-', '');
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}-${dateStr}-${random}`;
};

// 1. Get all expenses with pagination, search & filters
export const getExpenses = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.max(1, parseInt(req.query.limit) || 15);
        const skip = (page - 1) * limit;

        const { search, category, paymentStatus, paymentMethod, startDate, endDate, sortBy, sortOrder } = req.query;

        const query = { brand };

        if (category && category !== 'all') {
            query.category = category;
        }

        if (paymentStatus && paymentStatus !== 'all') {
            query.paymentStatus = paymentStatus;
        }

        if (paymentMethod && paymentMethod !== 'all') {
            query.paymentMethod = paymentMethod;
        }

        if (startDate || endDate) {
            query.expenseDate = {};
            if (startDate) {
                const s = new Date(startDate);
                s.setHours(0, 0, 0, 0);
                query.expenseDate.$gte = s;
            }
            if (endDate) {
                const e = new Date(endDate);
                e.setHours(23, 59, 59, 999);
                query.expenseDate.$lte = e;
            }
        }

        if (search && search.trim()) {
            const regex = new RegExp(search.trim(), 'i');
            query.$or = [
                { title: regex },
                { expenseNumber: regex },
                { referenceNumber: regex },
                { notes: regex }
            ];
        }

        const sort = {};
        const field = sortBy || 'expenseDate';
        const order = sortOrder === 'asc' ? 1 : -1;
        sort[field] = order;

        const [expenses, total] = await Promise.all([
            Expense.find(query)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .populate('createdBy', 'name email')
                .lean(),
            Expense.countDocuments(query)
        ]);

        return res.status(200).json({
            success: true,
            data: expenses,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching expenses:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve expenses',
            error: error.message
        });
    }
};

// 2. Summary stats for KPI cards & category distribution
export const getExpenseStats = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const now = new Date();

        // Beginning of current month
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // Beginning of today
        const startOfToday = new Date(now);
        startOfToday.setHours(0, 0, 0, 0);

        const [overall] = await Expense.aggregate([
            { $match: { brand, paymentStatus: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: '$amount' },
                    totalCount: { $sum: 1 }
                }
            }
        ]);

        const [thisMonth] = await Expense.aggregate([
            {
                $match: {
                    brand,
                    paymentStatus: { $ne: 'cancelled' },
                    expenseDate: { $gte: startOfMonth, $lte: endOfMonth }
                }
            },
            {
                $group: {
                    _id: null,
                    monthAmount: { $sum: '$amount' },
                    monthCount: { $sum: 1 }
                }
            }
        ]);

        const [today] = await Expense.aggregate([
            {
                $match: {
                    brand,
                    paymentStatus: { $ne: 'cancelled' },
                    expenseDate: { $gte: startOfToday }
                }
            },
            {
                $group: {
                    _id: null,
                    todayAmount: { $sum: '$amount' },
                    todayCount: { $sum: 1 }
                }
            }
        ]);

        const categoryBreakdown = await Expense.aggregate([
            { $match: { brand, paymentStatus: { $ne: 'cancelled' } } },
            {
                $group: {
                    _id: '$category',
                    total: { $sum: '$amount' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { total: -1 } }
        ]);

        return res.status(200).json({
            success: true,
            data: {
                totalAmount: overall?.totalAmount || 0,
                totalCount: overall?.totalCount || 0,
                thisMonthAmount: thisMonth?.monthAmount || 0,
                thisMonthCount: thisMonth?.monthCount || 0,
                todayAmount: today?.todayAmount || 0,
                todayCount: today?.todayCount || 0,
                categoryBreakdown: categoryBreakdown.map(c => ({
                    category: c._id,
                    total: Number(c.total.toFixed(2)),
                    count: c.count
                }))
            }
        });
    } catch (error) {
        console.error('Error fetching expense stats:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve expense statistics',
            error: error.message
        });
    }
};

// 3. Get single expense by ID
export const getExpenseById = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { id } = req.params;

        const expense = await Expense.findOne({ _id: id, brand })
            .populate('createdBy', 'name email')
            .lean();

        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Expense record not found'
            });
        }

        return res.status(200).json({
            success: true,
            data: expense
        });
    } catch (error) {
        console.error('Error fetching expense:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch expense details',
            error: error.message
        });
    }
};

// 4. Create new expense
export const createExpense = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const {
            title,
            category,
            amount,
            expenseDate,
            paymentMethod,
            paymentStatus,
            referenceNumber,
            receiptDocument,
            notes
        } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Expense title is required'
            });
        }

        const parsedAmount = Number(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid expense amount greater than 0 is required'
            });
        }

        const expenseNumber = await generateExpenseNumber(brand);

        const newExpense = new Expense({
            expenseNumber,
            brand,
            title: title.trim(),
            category: category || 'miscellaneous',
            amount: Number(parsedAmount.toFixed(2)),
            expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
            paymentMethod: paymentMethod || 'upi',
            paymentStatus: paymentStatus || 'paid',
            referenceNumber: referenceNumber ? referenceNumber.trim() : undefined,
            receiptDocument: receiptDocument ? receiptDocument.trim() : undefined,
            notes: notes ? notes.trim() : undefined,
            createdBy: req.user?._id
        });

        await newExpense.save();

        return res.status(201).json({
            success: true,
            message: 'Expense recorded successfully',
            data: newExpense
        });
    } catch (error) {
        console.error('Error creating expense:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to record expense',
            error: error.message
        });
    }
};

// 5. Update expense
export const updateExpense = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { id } = req.params;
        const {
            title,
            category,
            amount,
            expenseDate,
            paymentMethod,
            paymentStatus,
            referenceNumber,
            receiptDocument,
            notes
        } = req.body;

        const expense = await Expense.findOne({ _id: id, brand });
        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Expense record not found'
            });
        }

        if (title !== undefined) expense.title = title.trim();
        if (category !== undefined) expense.category = category;
        if (amount !== undefined) {
            const parsed = Number(amount);
            if (isNaN(parsed) || parsed <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Valid amount greater than 0 is required'
                });
            }
            expense.amount = Number(parsed.toFixed(2));
        }
        if (expenseDate !== undefined) expense.expenseDate = new Date(expenseDate);
        if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod;
        if (paymentStatus !== undefined) expense.paymentStatus = paymentStatus;
        if (referenceNumber !== undefined) expense.referenceNumber = referenceNumber ? referenceNumber.trim() : '';
        if (receiptDocument !== undefined) expense.receiptDocument = receiptDocument ? receiptDocument.trim() : '';
        if (notes !== undefined) expense.notes = notes ? notes.trim() : '';

        await expense.save();

        return res.status(200).json({
            success: true,
            message: 'Expense updated successfully',
            data: expense
        });
    } catch (error) {
        console.error('Error updating expense:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update expense',
            error: error.message
        });
    }
};

// 6. Delete expense
export const deleteExpense = async (req, res) => {
    try {
        const brand = req.activeBrand || req.params.brand || 'teasntrees';
        const { id } = req.params;

        const expense = await Expense.findOneAndDelete({ _id: id, brand });
        if (!expense) {
            return res.status(404).json({
                success: false,
                message: 'Expense record not found'
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Expense deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting expense:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete expense',
            error: error.message
        });
    }
};

