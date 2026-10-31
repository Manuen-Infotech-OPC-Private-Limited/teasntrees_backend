import express from 'express';
import {
    getSalesSummary,
    getSalesTrends,
    getSalesBreakdown,
    getTopProducts,
    getSalesOrders,
    exportSalesCSV
} from '../../controllers/admin/salesController.js';

const router = express.Router({ mergeParams: true });

router.get('/summary', getSalesSummary);
router.get('/trends', getSalesTrends);
router.get('/breakdown', getSalesBreakdown);
router.get('/top-products', getTopProducts);
router.get('/orders', getSalesOrders);
router.get('/export', exportSalesCSV);

export default router;

