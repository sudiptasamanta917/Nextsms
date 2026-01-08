import wweb from "whatsapp-web.js";
const { Client, LocalAuth } = wweb;

import asyncHandler from "express-async-handler";
import { Business } from "../models/business.model.js";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

/* =======================
   GLOBAL SAFETY GUARD
   ======================= */
process.on("unhandledRejection", (reason) => {
    if (
        reason?.message?.includes("Target closed") ||
        reason?.message?.includes("Execution context was destroyed") ||
        reason?.message?.includes("Protocol error")
    ) {
        console.warn("[SAFE-EXIT] Puppeteer target closed, ignoring");
        return;
    }
    console.error("Unhandled Rejection:", reason);
});

/* =======================
   GLOBAL STATE
   ======================= */
export const clients = {};
const initializing = new Set();

/* =======================
   AUTH PATH
   ======================= */
const AUTH_PATH =
    process.env.NODE_ENV === "production"
        ? "/var/www/nextsms.co.in/next_sms/server/.wwebjs_auth"
        : path.resolve("./server/.wwebjs_auth");

/* =======================
   CLEAN BROKEN SESSION
   ======================= */
const cleanBrokenSession = (businessId) => {
    const sessionPath = path.join(AUTH_PATH, `session-${businessId}`);
    const credsPath = path.join(sessionPath, "creds.json");

    if (fs.existsSync(sessionPath) && !fs.existsSync(credsPath)) {
        console.warn(`[CLEANUP] Removing broken session for ${businessId}`);
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
};

/* =======================
   RESTORE SESSIONS
   ======================= */
export const restoreSessions = async () => {
    console.log(`[SESSION RESTORE] Checking ${AUTH_PATH}`);

    if (!fs.existsSync(AUTH_PATH)) return;

    const dirs = fs
        .readdirSync(AUTH_PATH)
        .filter((d) => d.startsWith("session-"));

    for (const dir of dirs) {
        const businessId = dir.replace("session-", "");
        const creds = path.join(AUTH_PATH, dir, "creds.json");

        if (!fs.existsSync(creds)) {
            cleanBrokenSession(businessId);
            continue;
        }

        await initializeClient(businessId);
    }
};

/* =======================
   INITIALIZE CLIENT
   ======================= */
const initializeClient = async (businessId) => {
    if (clients[businessId] || initializing.has(businessId)) return;

    cleanBrokenSession(businessId);
    initializing.add(businessId);

    console.log(`[INIT] Initializing WhatsApp for ${businessId}`);

    try {
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: businessId,
                dataPath: AUTH_PATH,
            }),
            puppeteer: {
                headless: false, // IMPORTANT for stability
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-background-timer-throttling",
                    "--disable-backgrounding-occluded-windows",
                ],
            },
        });

        clients[businessId] = {
            instance: client,
            status: "initializing",
            qr: null,
        };

        client.on("qr", (qr) => handleQr(businessId, qr));
        client.on("ready", () => handleReady(businessId));
        client.on("auth_failure", (msg) =>
            handleClientDisconnect(businessId, msg)
        );
        client.on("disconnected", (reason) =>
            handleClientDisconnect(businessId, reason)
        );

        await client.initialize();
    } catch (err) {
        console.error(`[INIT ERROR] ${businessId}`, err.message);
        initializing.delete(businessId);
        await handleClientDisconnect(businessId, err.message);
    }
};

/* =======================
   QR HANDLER
   ======================= */
const handleQr = async (businessId, qr) => {
    const clientData = clients[businessId];
    if (!clientData || clientData.status === "disconnected") return;

    console.log(`[QR] Generated for ${businessId}`);

    clientData.qr = await qrcode.toDataURL(qr);
    await Business.findByIdAndUpdate(businessId, {
        sessionStatus: "qr_pending",
    });
};

/* =======================
   READY HANDLER
   ======================= */
const handleReady = async (businessId) => {
    const clientData = clients[businessId];
    if (!clientData || clientData.status === "ready") return;

    console.log(`[READY] Client ready for ${businessId}`);

    clientData.status = "ready";
    clientData.qr = null;

    initializing.delete(businessId);

    await Business.findByIdAndUpdate(businessId, {
        sessionStatus: "connected",
    });
};

/* =======================
   DISCONNECT HANDLER
   ======================= */
const handleClientDisconnect = async (businessId, reason) => {
    console.warn(`[DISCONNECTED] ${businessId}. Reason: ${reason}`);

    const clientData = clients[businessId];

    if (clientData?.instance) {
        try {
            await clientData.instance.destroy();
        } catch (_) {}
    }

    delete clients[businessId];
    initializing.delete(businessId);

    await Business.findByIdAndUpdate(businessId, {
        sessionStatus: "disconnected",
    });

    // IMPORTANT: Do NOT auto reconnect on LOGOUT
};

/* =======================
   API: CONNECT SESSION
   ======================= */
export const connectSession = asyncHandler(async (req, res) => {
    const businessId = req.business._id.toString();

    if (clients[businessId]) {
        return res.status(409).json({ message: "Session already active" });
    }

    await initializeClient(businessId);

    let attempts = 0;
    const timer = setInterval(() => {
        if (clients[businessId]?.qr) {
            clearInterval(timer);
            return res.json({ qrCodeUrl: clients[businessId].qr });
        }

        if (++attempts > 30) {
            clearInterval(timer);
            return res.status(408).json({ message: "QR generation timeout" });
        }
    }, 2000);
});

/* =======================
   API: SESSION STATUS
   ======================= */
export const getSessionStatus = asyncHandler(async (req, res) => {
    const businessId = req.business._id.toString();
    const client = clients[businessId];

    if (client?.status === "ready") return res.json({ status: "connected" });

    if (client?.qr) return res.json({ status: "qr_pending" });

    const business = await Business.findById(businessId);
    return res.json({ status: business?.sessionStatus || "disconnected" });
});

/* =======================
   API: DISCONNECT SESSION
   ======================= */
export const disconnectSession = asyncHandler(async (req, res) => {
    const businessId = req.business._id.toString();
    await handleClientDisconnect(businessId, "USER_LOGOUT");

    res.json({ message: "Disconnected successfully" });
});
