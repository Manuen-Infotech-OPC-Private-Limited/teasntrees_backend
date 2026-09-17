import Settings from '../../models/Settings.js';
import Outlet from '../../models/Outlet.js';
import activityLogService from '../../services/activityLogService.js';

// Get application settings
export const getSettings = async (req, res) => {
    try {
        let settings = await Settings.findOne({ brand: req.activeBrand });
        // create default settings if none exist
        if (!settings) {
            settings = await Settings.create({
                brand: req.activeBrand,
                deliveryCharge: 20,
                maxDeliveryDistance: 10,
                gstRate: 5,
                minOrderAmount: 100
            });
        }
        res.status(200).json({
            success: true,
            data: settings
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching settings',
            error: error.message
        });
    }
};

// Update application settings
export const updateSettings = async (req, res) => {
    try {
        const settings = await Settings.findOneAndUpdate(
            { brand: req.activeBrand },
            {
                $set: req.body,
                updatedBy: req.user.userId // Track who updated
            },
            {
                new: true, // Return updated doc
                upsert: true, // Create if doesn't exist
                runValidators: true
            }
        );

        // Emit Socket.io event
        const socketService = req.app.get('socketService');
        if (socketService) {
            socketService.notifyRole('manager', 'settings:updated', {
                updatedFields: Object.keys(req.body)
            });
            socketService.notifyRole('admin', 'settings:updated', {
                updatedFields: Object.keys(req.body)
            });
        }
        const io = req.app.get('io');
        if (io) {
            io.emit('settings:updated', {
                brand: req.activeBrand,
                updatedFields: Object.keys(req.body)
            });
        }

        // Log Activity in background
        activityLogService.log(req, {
            action: 'update',
            resource: 'settings',
            details: { updatedFields: Object.keys(req.body) }
        }).catch(() => { });

        return res.status(200).json({
            success: true,
            message: 'Settings updated successfully',
            data: settings
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error updating settings',
            error: error.message
        });
    }
};

// Get delivery zones (mapped to serviceAreas)
export const getDeliveryZones = async (req, res) => {
    try {
        const settings = await Settings.findOne({ brand: req.activeBrand });
        if (!settings || !settings.serviceAreas) {
            return res.status(200).json({
                success: true,
                data: []
            });
        }
        res.status(200).json({
            success: true,
            data: settings.serviceAreas
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching delivery zones',
            error: error.message
        });
    }
};

// update delivery zones (mapped to serviceAreas)
export const updateDeliveryZones = async (req, res) => {
    try {
        const { serviceAreas } = req.body;

        if (!Array.isArray(serviceAreas)) {
            return res.status(400).json({
                success: false,
                message: 'Service areas must be an array'
            });
        }

        const settings = await Settings.findOneAndUpdate(
            { brand: req.activeBrand },
            {
                $set: { serviceAreas },
                updatedBy: req.user.userId
            },
            {
                new: true,
                upsert: true,
                runValidators: true
            }
        );

        // Emit Socket.io event
        const socketService = req.app.get('socketService');
        if (socketService) {
            socketService.notifyRole('manager', 'delivery-zones:updated', {
                zonesCount: serviceAreas.length
            });
            socketService.notifyRole('admin', 'delivery-zones:updated', {
                zonesCount: serviceAreas.length
            });
            // Notify customers about new delivery zones
            socketService.notifyRole('customer', 'delivery-zones:updated', {
                message: 'Delivery zones have been updated'
            });
        }

        // Log Activity in background
        activityLogService.log(req, {
            action: 'update_zones',
            resource: 'settings',
            details: { zonesCount: serviceAreas.length }
        }).catch(() => { });

        return res.status(200).json({
            success: true,
            message: 'Delivery zones updated successfully',
            data: settings.serviceAreas
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error updating delivery zones',
            error: error.message
        });
    }
};

// Get all active outlets for filtering
export const getOutlets = async (req, res) => {
    try {
        const query = { isActive: true };
        if (req.activeBrand) query.brand = req.activeBrand;

        const outlets = await Outlet.find(query)
            .select('name location address brand')
            .sort({ name: 1 });

        res.status(200).json({
            success: true,
            data: outlets
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching outlets',
            error: error.message
        });
    }
};