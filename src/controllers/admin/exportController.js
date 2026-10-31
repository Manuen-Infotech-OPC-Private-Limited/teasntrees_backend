import XLSX from 'xlsx';
import Product from '../../models/Product.js';
import Category from '../../models/Category.js';
import Vendor from '../../models/Vendor.js';
import Purchase from '../../models/Purchase.js';
import Order from '../../models/Order.js';
import User from '../../models/User.js';
import Rider from '../../models/Rider.js';
import Manager from '../../models/Manager.js';
import Delivery from '../../models/Delivery.js';
import Expense from '../../models/Expense.js';

// Helper to format date strings cleanly for spreadsheets
const formatDate = (date) => {
    if (!date) return 'N/A';
    try {
        const d = new Date(date);
        return isNaN(d.getTime()) ? 'N/A' : d.toISOString().replace('T', ' ').slice(0, 19);
    } catch {
        return 'N/A';
    }
};

// Generic helper to send either CSV or XLSX
const sendExport = (res, data, resourceName, format = 'csv') => {
    const safeFormat = (format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `${resourceName}-export-${timestamp}`;

    const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ Message: 'No records found' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, resourceName.slice(0, 31));

    if (safeFormat === 'xlsx') {
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
        return res.status(200).send(buffer);
    } else {
        const csv = XLSX.utils.sheet_to_csv(ws);
        // Include UTF-8 BOM so Excel opens Indian rupee signs and special characters properly
        const bom = '\uFEFF';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.status(200).send(bom + csv);
    }
};

export const exportResource = async (req, res) => {
    try {
        const { resource } = req.params;
        const { format = 'csv', startDate, endDate, search, status } = req.query;
        const brand = req.activeBrand || req.query.brand;

        // Base filter with brand if applicable
        const brandFilter = brand ? { brand } : {};
        const dateFilter = {};
        if (startDate || endDate) {
            dateFilter.createdAt = {};
            if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                dateFilter.createdAt.$lte = end;
            }
        }

        switch (resource.toLowerCase()) {
            case 'products': {
                const query = { ...brandFilter };
                if (status) query.isActive = status === 'active';
                if (search) query.name = { $regex: search, $options: 'i' };

                const products = await Product.find(query)
                    .populate('category', 'name')
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = products.map((p) => ({
                    'Product ID': String(p._id),
                    'Product Name': p.name || '',
                    'Category': p.category?.name || 'Uncategorized',
                    'Brand': p.brand || '',
                    'Base Price (INR)': p.price ?? 0,
                    'Discount Price (INR)': p.discountPrice ?? p.price ?? 0,
                    'In Stock': p.inStock ? 'Yes' : 'No',
                    'Active Status': p.isActive ? 'Active' : 'Inactive',
                    'Seasonal Product': p.isSeasonal ? 'Yes' : 'No',
                    'Average Rating': p.ratings?.average ?? 0,
                    'Total Ratings': p.ratings?.count ?? 0,
                    'Created Date': formatDate(p.createdAt)
                }));

                return sendExport(res, exportData, 'products', format);
            }

            case 'categories': {
                const query = { ...brandFilter };
                if (status) query.isActive = status === 'active';
                if (search) query.name = { $regex: search, $options: 'i' };

                const categories = await Category.find(query)
                    .sort({ sortOrder: 1, createdAt: -1 })
                    .lean();

                const exportData = categories.map((c) => ({
                    'Category ID': String(c._id),
                    'Category Name': c.name || '',
                    'Slug': c.slug || '',
                    'Brand': c.brand || '',
                    'Active Status': c.isActive ? 'Active' : 'Inactive',
                    'Sort Order': c.sortOrder ?? 0,
                    'Created Date': formatDate(c.createdAt)
                }));

                return sendExport(res, exportData, 'categories', format);
            }

            case 'vendors': {
                const query = { ...brandFilter };
                if (status) query.isActive = status === 'active';
                if (search) {
                    query.$or = [
                        { companyName: { $regex: search, $options: 'i' } },
                        { name: { $regex: search, $options: 'i' } },
                        { phone: { $regex: search, $options: 'i' } }
                    ];
                }

                const vendors = await Vendor.find(query)
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = vendors.map((v) => ({
                    'Vendor ID': String(v._id),
                    'Company Name': v.companyName || '',
                    'Contact Person': v.name || '',
                    'Phone': v.phone || '',
                    'Email': v.email || 'N/A',
                    'Brand': v.brand || '',
                    'Category': (v.category || '').replace(/_/g, ' '),
                    'GSTIN': v.gstin || 'N/A',
                    'Payment Terms': v.paymentTerms || 'immediate',
                    'Total Spend (INR)': v.totalSpend ?? 0,
                    'Total Paid (INR)': v.totalPaid ?? 0,
                    'Balance Due (INR)': v.balanceDue ?? 0,
                    'Bank Name': v.bankDetails?.bankName || 'N/A',
                    'Account Number': v.bankDetails?.accountNumber || 'N/A',
                    'IFSC Code': v.bankDetails?.ifscCode || 'N/A',
                    'Active Status': v.isActive ? 'Active' : 'Inactive',
                    'Created Date': formatDate(v.createdAt)
                }));

                return sendExport(res, exportData, 'vendors', format);
            }

            case 'purchases': {
                const query = { ...brandFilter };
                if (status) query.status = status;
                if (startDate || endDate) {
                    query.invoiceDate = {};
                    if (startDate) query.invoiceDate.$gte = new Date(startDate);
                    if (endDate) {
                        const end = new Date(endDate);
                        end.setHours(23, 59, 59, 999);
                        query.invoiceDate.$lte = end;
                    }
                }

                const purchases = await Purchase.find(query)
                    .populate('vendor', 'companyName name phone')
                    .sort({ invoiceDate: -1 })
                    .lean();

                const exportData = purchases.map((p) => ({
                    'Purchase Number': p.purchaseNumber || '',
                    'Brand': p.brand || '',
                    'Supplier Company': p.vendor?.companyName || 'N/A',
                    'Contact Person': p.vendor?.name || 'N/A',
                    'Supplier Phone': p.vendor?.phone || 'N/A',
                    'Invoice Number': p.invoiceNumber || '',
                    'Invoice Date': formatDate(p.invoiceDate),
                    'Line Items Count': p.items?.length ?? 0,
                    'Subtotal (INR)': p.subtotal ?? 0,
                    'Tax Amount (INR)': p.taxAmount ?? 0,
                    'Total Amount (INR)': p.totalAmount ?? 0,
                    'Paid Amount (INR)': p.paidAmount ?? 0,
                    'Balance Due (INR)': p.balanceAmount ?? 0,
                    'Payment Status': (p.paymentStatus || '').toUpperCase(),
                    'Bill Status': (p.status || '').toUpperCase(),
                    'Created Date': formatDate(p.createdAt)
                }));

                return sendExport(res, exportData, 'purchases', format);
            }

            case 'orders': {
                const query = { ...brandFilter, ...dateFilter };
                if (status) query.status = status;

                const orders = await Order.find(query)
                    .populate('customerId', 'name mobile email')
                    .populate('riderId', 'name mobile')
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = orders.map((o) => {
                    const itemsSummary = (o.items || [])
                        .map((i) => `${i.name} (x${i.quantity})`)
                        .join('; ');

                    return {
                        'Order Number': o.orderNumber || '',
                        'Brand': o.brand || '',
                        'Customer Name': o.customerId?.name || o.deliveryAddress?.name || 'Customer',
                        'Customer Mobile': o.customerId?.mobile || o.deliveryAddress?.phone || 'N/A',
                        'Customer Email': o.customerId?.email || 'N/A',
                        'Items Summary': itemsSummary,
                        'Total Items Count': o.items?.reduce((acc, curr) => acc + (curr.quantity || 1), 0) ?? 0,
                        'Subtotal (INR)': o.subtotal ?? 0,
                        'Discount (INR)': o.discount ?? 0,
                        'Delivery Fee (INR)': o.deliveryCharge ?? 0,
                        'Tax (INR)': o.tax ?? 0,
                        'Net Total (INR)': o.total ?? o.totalAmount ?? 0,
                        'Payment Method': (o.paymentMethod || 'COD').toUpperCase(),
                        'Payment Status': (o.paymentStatus || 'pending').toUpperCase(),
                        'Order Status': (o.status || '').toUpperCase(),
                        'Rider Assigned': o.riderId?.name || 'Unassigned',
                        'Delivery Address': o.deliveryAddress?.street || o.deliveryAddress?.addressLine || 'N/A',
                        'Order Date': formatDate(o.createdAt)
                    };
                });

                return sendExport(res, exportData, 'orders', format);
            }

            case 'customers': {
                const query = { role: 'customer' };
                if (status) query.isActive = status === 'active';
                if (search) {
                    query.$or = [
                        { name: { $regex: search, $options: 'i' } },
                        { mobile: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } }
                    ];
                }

                const customers = await User.find(query)
                    .select('-password -__v')
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = customers.map((c) => ({
                    'Customer ID': String(c._id),
                    'Full Name': c.name || '',
                    'Mobile': c.mobile || '',
                    'Email': c.email || 'N/A',
                    'Active Status': c.isActive ? 'Active' : 'Inactive',
                    'Registered Date': formatDate(c.createdAt)
                }));

                return sendExport(res, exportData, 'customers', format);
            }

            case 'riders': {
                const query = {};
                if (status) query.isActive = status === 'active';

                const riders = await Rider.find(query)
                    .select('-password -__v')
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = riders.map((r) => ({
                    'Rider ID': String(r._id),
                    'Rider Code': r.riderId || 'N/A',
                    'Full Name': r.name || '',
                    'Mobile': r.mobile || '',
                    'Email': r.email || 'N/A',
                    'Vehicle Type': r.vehicleType || 'Bike',
                    'Vehicle Number': r.vehicleNumber || 'N/A',
                    'Approval Status': r.isApproved ? 'Approved' : 'Pending',
                    'Active Status': r.isActive ? 'Active' : 'Inactive',
                    'Duty Availability': r.isAvailable ? 'Online' : 'Offline',
                    'Joined Date': formatDate(r.createdAt)
                }));

                return sendExport(res, exportData, 'riders', format);
            }

            case 'managers': {
                const query = { ...brandFilter };
                if (status) query.isActive = status === 'active';
                if (search) {
                    query.$or = [
                        { name: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } },
                        { mobile: { $regex: search, $options: 'i' } }
                    ];
                }

                const managers = await Manager.find(query)
                    .select('-password -__v')
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = managers.map((m) => ({
                    'Manager ID': String(m._id),
                    'Full Name': m.name || '',
                    'Email': m.email || '',
                    'Mobile': m.mobile || '',
                    'Assigned Brand': m.brand || '',
                    'Approval Status': m.isApproved ? 'Approved' : 'Pending',
                    'Active Status': m.isActive ? 'Active' : 'Inactive',
                    'Joined Date': formatDate(m.createdAt)
                }));

                return sendExport(res, exportData, 'managers', format);
            }

            case 'deliveries': {
                const query = { ...brandFilter, ...dateFilter };
                if (status) query.status = status;

                const deliveries = await Delivery.find(query)
                    .populate('orderId', 'orderNumber brand total')
                    .populate('riderId', 'name mobile')
                    .populate('customerId', 'name mobile')
                    .sort({ createdAt: -1 })
                    .lean();

                const exportData = deliveries.map((d) => ({
                    'Delivery ID': String(d._id),
                    'Order Number': d.orderId?.orderNumber || 'N/A',
                    'Brand': d.brand || d.orderId?.brand || '',
                    'Rider Name': d.riderId?.name || 'Unassigned',
                    'Rider Phone': d.riderId?.mobile || 'N/A',
                    'Customer Name': d.customerId?.name || 'N/A',
                    'Customer Phone': d.customerId?.mobile || 'N/A',
                    'Delivery Status': (d.status || '').toUpperCase(),
                    'Distance (KM)': d.distance ?? 0,
                    'Delivery Fee (INR)': d.deliveryFee ?? 0,
                    'Rider Earning (INR)': d.totalEarning ?? 0,
                    'Earning Paid': d.isPaid ? 'Yes' : 'No',
                    'Created Date': formatDate(d.createdAt)
                }));

                return sendExport(res, exportData, 'deliveries', format);
            }

            case 'expenses': {
                const query = { ...brandFilter, ...dateFilter };
                if (status && status !== 'all') query.paymentStatus = status;
                if (req.query.category && req.query.category !== 'all') query.category = req.query.category;
                if (search) {
                    query.$or = [
                        { title: { $regex: search, $options: 'i' } },
                        { expenseNumber: { $regex: search, $options: 'i' } },
                        { referenceNumber: { $regex: search, $options: 'i' } },
                        { notes: { $regex: search, $options: 'i' } }
                    ];
                }

                const expenses = await Expense.find(query)
                    .populate('createdBy', 'name email')
                    .sort({ expenseDate: -1 })
                    .lean();

                const exportData = expenses.map((e) => ({
                    'Expense #': e.expenseNumber,
                    'Title': e.title,
                    'Category': (e.category || '').toUpperCase(),
                    'Amount (INR)': e.amount || 0,
                    'Expense Date': formatDate(e.expenseDate),
                    'Payment Status': (e.paymentStatus || '').toUpperCase(),
                    'Payment Method': (e.paymentMethod || '').toUpperCase(),
                    'Reference #': e.referenceNumber || 'N/A',
                    'Notes': e.notes || '',
                    'Recorded By': e.createdBy?.name || 'Admin',
                    'Created At': formatDate(e.createdAt)
                }));

                return sendExport(res, exportData, 'expenses', format);
            }

            default:
                return res.status(400).json({
                    success: false,
                    message: `Invalid export resource: "${resource}". Allowed: products, categories, vendors, purchases, orders, customers, riders, managers, deliveries, expenses`
                });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

