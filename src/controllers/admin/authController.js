// Admin Authentication Controller
// Role: 'admin' (auto-assigned)
// App: Admin Panel

import User from '../../models/User.js';
import RefreshToken from '../../models/RefreshToken.js';
import { generateToken, generateRefreshToken } from '../../utils/jwtHelper.js';
import { isValidEmail, sanitizeString } from '../../utils/validators.js';
import logger from '../../config/logger.js';
import { verifyFirebaseToken } from '../../services/firebaseAuth.js';
import activityLogService from '../../services/activityLogService.js';

// Complete user profile after Firebase login (requires JWT)
const completeProfile = async (req, res) => {
    try {
        const { name, email, address } = req.body;

        // 1. Identify User via JWT (Enforced by route middleware)
        if (!req.user || !req.user.userId) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const mobileNumber = user.mobile;

        // Validate required fields
        if (!name || !email || !address) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields: name, email, address'
            });
        }

        // Validate email
        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid email address'
            });
        }

        // update user
        user.name = sanitizeString(name);
        user.email = sanitizeString(email).toLowerCase();
        user.address = sanitizeString(address);
        user.isProfileComplete = true;

        // Ensure role is admin
        if (!user.role) user.role = 'admin';

        await user.save();

        // Generate JWT token
        const token = generateToken({
            userId: user._id,
            role: user.role
        });

        // Generate refresh token
        const refreshToken = generateRefreshToken();

        // Store refresh token in database
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90); // 90 days

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Log Activity
        await activityLogService.log(req, {
            action: 'complete_profile',
            resource: 'user',
            resourceId: user._id,
            details: { name: user.name, role: user.role }
        });

        return res.status(200).json({
            success: true,
            message: 'Profile completed successfully',
            data: {
                token,
                refreshToken,
                user: {
                    id: user._id,
                    name: user.name,
                    mobile: user.mobile,
                    email: user.email,
                    address: user.address,
                    role: user.role,
                    isProfileComplete: user.isProfileComplete
                }
            }
        });

    } catch (error) {
        logger.error('Error in completeProfile:', error);

        // Handle duplicate email error
        if (error.code === 11000 && error.keyPattern?.email) {
            return res.status(400).json({
                success: false,
                message: 'Email already in use'
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Failed to complete profile. Please try again.'
        });
    }
};

// Refresh access token using refresh token
const refreshAccessToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            logger.warn('Refresh token missing in request');
            return res.status(401).json({
                success: false,
                message: 'Refresh token required'
            });
        }

        // Find token in database
        const storedToken = await RefreshToken.findOne({
            token: refreshToken,
            isRevoked: false
        }).populate('user');

        if (!storedToken) {
            logger.warn('Invalid refresh token attempt', { token: refreshToken.substring(0, 20) });
            return res.status(401).json({
                success: false,
                message: 'Invalid or revoked refresh token'
            });
        }

        // Check expiry
        if (storedToken.expiresAt < new Date()) {
            logger.warn('Expired refresh token', { userId: storedToken.user._id });
            return res.status(401).json({
                success: false,
                message: 'Refresh token expired. Please login again.'
            });
        }

        // Check if user is still active
        if (!storedToken.user.isActive) {
            logger.warn('Refresh attempt by deactivated user', { userId: storedToken.user._id });
            return res.status(403).json({
                success: false,
                message: 'Account is deactivated'
            });
        }

        // TOKEN ROTATION: Revoke old token
        storedToken.isRevoked = true;
        storedToken.revokedAt = new Date();

        const newRefreshToken = generateRefreshToken();
        storedToken.replacedBy = newRefreshToken;
        await storedToken.save();

        // Create new refresh token
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: newRefreshToken,
            user: storedToken.user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Generate new access token
        const accessToken = generateToken({
            userId: storedToken.user._id,
            role: storedToken.user.role
        });

        logger.info('Token refreshed successfully', { userId: storedToken.user._id });

        res.json({
            success: true,
            token: accessToken,
            refreshToken: newRefreshToken
        });

    } catch (error) {
        logger.error('Error in refreshAccessToken', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Failed to refresh token'
        });
    }
};


const logout = async (req, res) => {
    try {
        const { refreshToken } = req.body || {};

        if (refreshToken) {
            const result = await RefreshToken.updateOne(
                { token: refreshToken },
                {
                    isRevoked: true,
                    revokedAt: new Date()
                }
            );

            logger.info('User logged out', {
                tokenRevoked: result.modifiedCount > 0
            });
        }

        res.status(200).json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        logger.error('Error in logout', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Failed to logout'
        });
    }
};

// Firebase-based login
const firebaseLogin = async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'Firebase ID token is required'
            });
        }

        // 1. Verify token
        const decoded = await verifyFirebaseToken(idToken);
        const mobile = decoded.phone_number.replace(/\D/g, '').slice(-10);

        // 2. Find/Create Admin
        let user = await User.findOne({ mobile, role: 'admin' });
        let isNewUser = false;

        if (!user) {
            isNewUser = true;
            user = await User.create({
                mobile,
                role: 'admin',
                brand: req.activeBrand,
                isProfileComplete: false
            });
            logger.info('New admin registered via Firebase', { mobile, userId: user._id });
        } else {
            if (user.role !== 'admin') {
                return res.status(403).json({
                    success: false,
                    message: `Account already exists with role: ${user.role}`
                });
            }

            if (!user.isActive) {
                return res.status(403).json({
                    success: false,
                    message: 'Account is deactivated. Please contact support.'
                });
            }

            // Check brand restriction
            if (user.brand && user.brand !== req.activeBrand) {
                return res.status(403).json({
                    success: false,
                    message: `This account is registered with ${user.brand === 'teasntrees' ? 'Teas N Trees' : 'Cream N Crust'}. Please log in through the correct portal.`
                });
            }

            // For existing admins who don't have a brand yet (from migration period), assign it now
            if (!user.brand) {
                user.brand = req.activeBrand;
                await user.save();
            }

            // Auto-heal isProfileComplete flag
            if (!user.isProfileComplete && user.checkProfileComplete()) {
                user.isProfileComplete = true;
                await user.save();
                logger.info('Auto-healed admin profile completion flag', { userId: user._id });
            }
        }

        // 3. Tokens
        const token = generateToken({ userId: user._id, role: user.role });
        const refreshToken = generateRefreshToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Log Activity
        await activityLogService.log(req, {
            adminId: user._id,
            action: 'firebase_login',
            resource: 'user',
            resourceId: user._id,
            details: { mobile: user.mobile, role: user.role, isNewUser }
        });

        // If user exists but profile is incomplete, or it's a new user
        if (!user.isProfileComplete) {
            return res.status(200).json({
                success: true,
                message: 'Login successful. Please complete your profile.',
                data: {
                    token,
                    refreshToken,
                    user: {
                        id: user._id,
                        mobile,
                        isNewUser,
                        isProfileComplete: false,
                        existingData: {
                            name: user.name,
                            email: user.email,
                            address: user.address,
                            role: user.role
                        }
                    }
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                refreshToken,
                user: {
                    id: user._id,
                    name: user.name,
                    mobile: user.mobile,
                    email: user.email,
                    role: user.role,
                    isProfileComplete: true
                }
            }
        });

    } catch (error) {
        logger.error('Firebase login error (Admin):', error);
        return res.status(401).json({ success: false, message: error.message });
    }
};

export {
    completeProfile,
    refreshAccessToken,
    logout,
    firebaseLogin
};
