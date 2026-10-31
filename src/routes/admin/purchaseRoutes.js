import express from 'express';
import {
    getPurchases,
    getPurchaseById,
    createPurchase,
    updatePurchase,
    recordPurchasePayment,
    deletePurchase,
    getPurchaseStats
} from '../../controllers/admin/purchaseController.js';
import { logActivity } from '../../middlewares/activityLogger.js';

const router = express.Router({ mergeParams: true });

router.get('/stats', getPurchaseStats);
router.get('/', getPurchases);
router.get('/:id', getPurchaseById);
router.post('/', logActivity('create', 'purchase'), createPurchase);
router.put('/:id', logActivity('update', 'purchase'), updatePurchase);
router.post('/:id/payment', logActivity('payment', 'purchase'), recordPurchasePayment);
router.delete('/:id', logActivity('delete', 'purchase'), deletePurchase);

export default router;

