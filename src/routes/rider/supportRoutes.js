import express from 'express';
import {
    reportIssue,
    getBalance,
    requestWithdrawal
} from '../../controllers/rider/supportController.js';
import { riderAuth, isApprovedRider } from '../../middlewares/riderAuth.js';

const router = express.Router({ mergeParams: true });

router.use(riderAuth);
router.use(isApprovedRider);

// Report an issue from the road.
router.post('/support/report', reportIssue);

// Earnings / withdrawal.
router.get('/earnings/balance', getBalance);
router.post('/earnings/withdraw', requestWithdrawal);

export default router;
