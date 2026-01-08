import dotenv from 'dotenv';
dotenv.config();
// --- THIS IS THE CRITICAL FIX ---
// 1. Import the entire bullmq package as a default import.
// 2. Then, destructure the specific components we need.
import bullmq from 'bullmq';
// 2. Then, destructure the specific components we need.
const { Worker } = bullmq;
// --- END OF FIX ---

import { clients, restoreSessions } from './controllers/whatsappController.js';
import { Business } from './models/business.model.js';
import { Message } from './models/message.model.js';
import { Campaign } from './models/campaign.model.js';
import connectDB from './db/db.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

console.log('[WORKER] Starting message worker process...');
const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
};

// This is the "battery" that will monitor Redis for delayed jobs
const worker = new Worker('messages', async (job) => {
    const { businessId, campaignId, recipient, text, mediaUrl, filePath } = job.data;
    console.log(`[WORKER] Processing message for ${recipient} from campaign ${campaignId || 'Single Send'}`);

    const clientData = clients[businessId];
    if (!clientData || clientData.status !== 'ready') {
        throw new Error('WhatsApp session not ready.');
    }

    const formattedNumber = `${recipient.replace(/\D/g, '')}@c.us`;

    try {
        const client = clientData.instance;
        let media = null;

        if (filePath) {
            media = MessageMedia.fromFilePath(filePath);
        } else if (mediaUrl) {
            media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
        }

        if (media) {
            await client.sendMessage(formattedNumber, media, { caption: text });
        } else {
            await client.sendMessage(formattedNumber, text);
        }

        await Business.findByIdAndUpdate(businessId, { $inc: { credits: -1 } });
        if(campaignId) {
            await Campaign.findByIdAndUpdate(campaignId, { $inc: { sentCount: 1 } });
        }
        await Message.create({ businessId, campaignId, recipient, content: text, status: 'sent', sentAt: new Date() });

    } catch (error) {
        console.error(`[WORKER] Failed to send message to ${recipient}:`, error.message);
        if(campaignId) {
            await Campaign.findByIdAndUpdate(campaignId, { $inc: { failedCount: 1 } });
        }
        await Message.create({ businessId, campaignId, recipient, content: text, status: 'failed', errorMessage: error.message });
        throw error;
    }

    const delay = Math.floor(Math.random() * (10000 - 4000 + 1)) + 4000;
    await new Promise(resolve => setTimeout(resolve, delay));

}, { connection });

worker.on('completed', (job) => {
  console.log(`[WORKER] Job ${job.id} has completed for recipient: ${job.data.recipient}`);
});

worker.on('failed', (job, err) => {
  console.log(`[WORKER] Job ${job.id} has failed for recipient: ${job.data.recipient} with ${err.message}`);
});

