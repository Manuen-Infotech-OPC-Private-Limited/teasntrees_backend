import admin from '../config/firebase.js';

// Verifies the idToken sent from the frontend

export const verifyFirebaseToken = async (idToken) => {
    // TEST BYPASS for End-to-End Simulation
    if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && idToken === 'test-token-123') {
        return {
            uid: 'test-user-firebase-uid',
            phone_number: '+919876543210', // Mock test number
            email: 'test@example.com'
        };
    }

    // Like an Apple sign-in after the first one: Apple shares no email again.
    if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && idToken === 'test-token-noemail') {
        return { uid: 'test-apple-uid-noemail' };
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        return decodedToken;
    } catch (error) {
        console.error('Error verifying Firebase token:', error);
        throw new Error('Unauthorized: Invalid or expired Firebase token');
    }
};

export { admin };
