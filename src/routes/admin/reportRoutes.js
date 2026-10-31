import express from 'express';
import {
    getPnLReport,
    getTaxReport,
    getProcurementReport,
    getReportTrends,
    getExpenseCategoryReport,
    exportPnLCSV
} from '../../controllers/admin/reportController.js';

const router = express.Router({ mergeParams: true });

router.get('/pnl', getPnLReport);
router.get('/tax', getTaxReport);
router.get('/procurement', getProcurementReport);
router.get('/trends', getReportTrends);
router.get('/expense-categories', getExpenseCategoryReport);
router.get('/export-pnl', exportPnLCSV);

export default router;

