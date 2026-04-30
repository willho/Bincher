import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { PinVerificationModal } from "@/components/pin-verification-modal";
import { apiRequest } from "@/lib/queryClient";

interface PendingSecurityAction {
  type: "trade" | "withdrawal" | "settings";
  description: string;
  onVerified: (pin: string) => Promise<void>;
}

interface SecurityContextType {
  requirePin: (action: PendingSecurityAction) => void;
  executeTradePendingPin: (onSuccess: () => void, description?: string) => Promise<void>;
}

const SecurityContext = createContext<SecurityContextType | null>(null);

export function SecurityProvider({ children }: { children: ReactNode }) {
  const [pendingAction, setPendingAction] = useState<PendingSecurityAction | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const requirePin = useCallback((action: PendingSecurityAction) => {
    setPendingAction(action);
    setModalOpen(true);
  }, []);

  const handleVerified = useCallback(async (pin: string) => {
    if (pendingAction) {
      await pendingAction.onVerified(pin);
    }
    setPendingAction(null);
  }, [pendingAction]);

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setPendingAction(null);
  }, []);

  const executeTradePendingPin = useCallback(async (onSuccess: () => void, description = "this trade") => {
    try {
      const response = await apiRequest("POST", "/api/trade/execute-pending");
      const data = await response.json();
      
      if (data.pinRequired) {
        requirePin({
          type: "trade",
          description,
          onVerified: async (pin) => {
            const retryResponse = await apiRequest("POST", "/api/trade/execute-pending", { pin });
            const retryData = await retryResponse.json();
            if (retryData.success) {
              onSuccess();
            }
          }
        });
      } else if (data.success) {
        onSuccess();
      }
    } catch (error) {
      console.error("Trade execution error:", error);
    }
  }, [requirePin]);

  return (
    <SecurityContext.Provider value={{ requirePin, executeTradePendingPin }}>
      {children}
      <PinVerificationModal
        open={modalOpen}
        onClose={handleClose}
        onVerified={handleVerified}
        actionDescription={pendingAction?.description}
      />
    </SecurityContext.Provider>
  );
}

export function useSecurity() {
  const context = useContext(SecurityContext);
  if (!context) {
    throw new Error("useSecurity must be used within SecurityProvider");
  }
  return context;
}
