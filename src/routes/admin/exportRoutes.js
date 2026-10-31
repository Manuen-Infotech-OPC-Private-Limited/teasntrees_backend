import express from 'express';
import { exportResource } from '../../controllers/admin/exportController.js';

const router = express.Router({ mergeParams: true });

// GET /admin/export/:resource?format=csv|xlsx
router.get('/:resource', exportResource);

export default router;

