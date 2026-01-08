import React, { useState, useEffect, useCallback, useRef } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../../hooks/useAuth";
import Modal from "../ui/Modal";
import { Wifi, WifiOff, QrCode, LoaderCircle, RefreshCw } from "lucide-react";
import { createAuthenticatedApi } from "../../services/api";

const ConnectionCard = () => {
  const { token, logout } = useAuth();
  const [status, setStatus] = useState("loading");
  const statusRef = useRef(status); // <-- NEW: ref to hold latest status
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [isActionLoading, setIsActionLoading] = useState(false);
  const pollingInterval = useRef(null);
  const connectToastId = useRef(null);
  const fetchController = useRef(null);

  // Keep the ref in sync with state so fetchStatus can read latest value without being re-created
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const stopPolling = useCallback(() => {
    if (pollingInterval.current) {
      clearInterval(pollingInterval.current);
      pollingInterval.current = null;
    }
  }, []);

  const fetchStatus = useCallback(
    async (showLoading = false) => {
      // Use statusRef.current instead of status to avoid recreating this callback when status changes
      if (showLoading && statusRef.current !== "initializing")
        setStatus("loading");

      if (fetchController.current) {
        fetchController.current.abort();
      }
      fetchController.current = new AbortController();

      try {
        const api = createAuthenticatedApi(token);
        const response = await api.get("/session/status", {
          signal: fetchController.current.signal,
        });
        const newStatus = response.data.status || "disconnected";

        setStatus((prevStatus) => {
          if (prevStatus !== newStatus) {
            if (prevStatus === "qr_pending" && newStatus === "connected") {
              if (connectToastId.current) {
                toast.success("WhatsApp successfully connected!", {
                  id: connectToastId.current,
                });
                connectToastId.current = null;
              }
            }
            if (newStatus === "connected" || newStatus === "disconnected") {
              stopPolling();
              setIsModalOpen(false);
            }
            return newStatus;
          }
          return prevStatus;
        });
      } catch (error) {
        if (error.name === "CanceledError" || error.name === "AbortError") {
          // intentional abort
          console.log("Fetch status request was intentionally canceled.");
          return;
        }
        console.error("Failed to fetch status:", error);
        setStatus("disconnected");
        stopPolling();
        if (error.response?.status === 401) {
          toast.error("Session expired. Please log in again.");
          logout();
        }
      }
    },
    [token, logout, stopPolling] // <-- NOTE: `status` removed from deps
  );

  useEffect(() => {
    if (token) {
      // Only one interval controlled by this effect; it will not re-run when `status` changes
      pollingInterval.current = setInterval(() => {
        fetchStatus();
      }, 3000);
    }
    return () => {
      stopPolling();
      if (fetchController.current) fetchController.current.abort();
    };
  }, [fetchStatus, token, stopPolling]);

  const handleConnect = async () => {
    setIsActionLoading(true);
    connectToastId.current = toast.loading("Initializing session...");
    try {
      const api = createAuthenticatedApi(token);
      const response = await api.post("/session/connect");
      setQrCodeUrl(response.data.qrCodeUrl);
      setIsModalOpen(true);
      setStatus("qr_pending");
      toast.loading("QR Code ready. Please scan.", {
        id: connectToastId.current,
      });
      stopPolling(); // Stop background polling while waiting for QR
      pollingInterval.current = setInterval(() => {
        fetchStatus();
      }, 3000);
    } catch (error) {
      const errorMessage =
        error.response?.data?.message || "Failed to generate QR code.";
      toast.error(errorMessage, { id: connectToastId.current });
      connectToastId.current = null;
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDisconnect = async (showToast = true) => {
    // --- THIS IS THE CRITICAL FIX ---
    // 2. Immediately abort any in-flight status checks before doing anything else.
    if (fetchController.current) {
      fetchController.current.abort();
    }
    // --- END OF FIX ---

    stopPolling();
    setIsActionLoading(true);
    const toastId = showToast
      ? toast.loading("Disconnecting session...")
      : null;

    // Optimistically update the UI for instant feedback
    setStatus("disconnected");
    setIsModalOpen(false);
    setQrCodeUrl("");

    try {
      const api = createAuthenticatedApi(token);
      await api.delete("/session/disconnect");
      if (toastId)
        toast.success("Session disconnected successfully.", { id: toastId });
    } catch {
      if (toastId)
        toast.error("Failed to disconnect. Re-checking status.", {
          id: toastId,
        });
      // If the API call fails, fetch the true status from the server to correct the UI.
      setTimeout(() => fetchStatus(true), 500);
    } finally {
      setIsActionLoading(false);
    }
  };

  const StatusIndicator = () => {
    switch (status) {
      case "connected":
        return (
          <div className="flex items-center gap-2 text-green-400">
            <Wifi size={20} /> Connected
          </div>
        );
      case "disconnected":
        return (
          <div className="flex items-center gap-2 text-red-500">
            <WifiOff size={20} /> Disconnected
          </div>
        );
      case "qr_pending":
        return (
          <div className="flex items-center gap-2 text-yellow-400 animate-pulse">
            <QrCode size={20} /> Awaiting Scan...
          </div>
        );
      case "initializing":
        return (
          <div className="flex items-center gap-2 text-cyan-400 animate-pulse">
            <LoaderCircle size={20} className="animate-spin" /> Restoring
            session...
          </div>
        );
      default:
        return (
          <div className="flex items-center gap-2 text-neutral-500">
            <LoaderCircle size={20} className="animate-spin" /> Checking...
          </div>
        );
    }
  };

  return (
    <div className="bg-black/80 backdrop-blur-sm border border-neutral-800 rounded-2xl p-6 shadow-lg">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold text-white ">
          Connection{" "}
          <span className="bg-clip-text text-transparent bg-gradient-to-br from-cyan-400 to-indigo-500">
            Status
          </span>
        </h2>
        <button
          onClick={() => fetchStatus(true)}
          disabled={status === "loading" || status === "initializing"}
          className="text-neutral-400 hover:text-white disabled:text-neutral-600 disabled:cursor-not-allowed transition-colors"
          title="Refresh Status"
        >
          <RefreshCw
            size={18}
            className={
              status === "loading" || status === "initializing"
                ? "animate-spin"
                : ""
            }
          />
        </button>
      </div>
      <div className="text-lg font-semibold mb-6">
        <StatusIndicator />
      </div>
      <div className="flex gap-4">
        {(status === "disconnected" || status === "initializing") && (
          <button
            onClick={handleConnect}
            disabled={isActionLoading || status === "initializing"}
            className="flex-1 text-center font-bold text-white bg-green-600 hover:bg-green-700 disabled:bg-green-800 disabled:cursor-not-allowed px-4 py-2 rounded-lg transition-colors"
          >
            Connect
          </button>
        )}
        {status === "qr_pending" && (
          <button
            onClick={() => handleDisconnect(true)}
            disabled={isActionLoading}
            className="flex-1 text-center font-bold text-white bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded-lg transition-colors"
          >
            Cancel Scan
          </button>
        )}
        {status === "connected" && (
          <button
            onClick={() => handleDisconnect(true)}
            disabled={isActionLoading}
            className="flex-1 text-center font-bold text-white bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg transition-colors"
          >
            Disconnect
          </button>
        )}
      </div>
      <Modal
        isOpen={isModalOpen}
        // --- THIS IS THE CRITICAL FIX ---
        // When the modal is closed (by clicking 'X' or outside),
        // we treat it as a "Cancel" action by calling handleDisconnect.
        onClose={() => {
          handleDisconnect(false); // Call handleDisconnect without a toast
        }}
      >
        {qrCodeUrl ? (
          <div className="bg-white p-4 rounded-lg">
            <img src={qrCodeUrl} alt="WhatsApp QR Code" />
          </div>
        ) : (
          <div className="flex justify-center items-center h-48">
            <LoaderCircle size={40} className="animate-spin" />
          </div>
        )}
        <p className="text-center text-sm text-neutral-400 mt-4">
          Scan this with WhatsApp on your phone from Settings &gt; Linked
          Devices.
        </p>
      </Modal>
    </div>
  );
};

export default ConnectionCard;
