import asyncHandler from 'express-async-handler';
import { Business } from '../models/business.model.js';
// --- THIS IS THE CRITICAL FIX ---
// The import path is now corrected to point to the correct location inside the /workers directory.
import { messageQueue } from '../workers/queue.js';

export const sendMessage = asyncHandler(async (req, res) => {
    const { recipient, text, mediaUrl, filePath } = req.body;
    const businessId = req.business._id;

    if (!recipient || !text) {0
        return res.status(400).json({ message: 'Recipient phone number and text are required.' });
    }

    const currentBusiness = await Business.findById(businessId);
    if (!currentBusiness || currentBusiness.credits <= 0) {
        return res.status(403).json({ message: 'Insufficient credits or business not found.' });
    }

    if (currentBusiness.sessionStatus !== 'connected') {
        return res.status(400).json({ message: 'WhatsApp session is not active. Please connect your device first.' });
    }

    try {
        // The controller's ONLY job is to add a job to the queue.
        // The worker (running in the same process) will handle the rest.
        await messageQueue.add('send-message', {
            businessId: businessId.toString(),
            recipient,
            text,
            filePath,
            mediaUrl,
        });

        // We respond with "Accepted" (202) because the message is now in the queue.
        res.status(202).json({ message: 'Message has been queued for sending.' });

    } catch (error) {
        console.error(`Failed to queue message for business ${businessId}:`, error);
        res.status(500).json({ message: 'Failed to queue message.' });
    }
});

