import express from 'express';
import {
    getExpenses,
    getExpenseStats,
    getExpenseById,
    createExpense,
    updateExpense,
    deleteExpense
} from '../../controllers/admin/expenseController.js';

const router = express.Router({ mergeParams: true });

router.get('/stats', getExpenseStats);
router.get('/', getExpenses);
router.get('/:id', getExpenseById);
router.post('/', createExpense);
router.put('/:id', updateExpense);
router.delete('/:id', deleteExpense);

export default router;

