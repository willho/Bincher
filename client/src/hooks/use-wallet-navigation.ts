import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";

interface WalletNavigationResult {
  navigateToWallet: (address: string, label?: string) => Promise<void>;
  isNavigating: boolean;
}

export function useWalletNavigation(): WalletNavigationResult {
  const [, navigate] = useLocation();
  const [isNavigating, setIsNavigating] = useState(false);

  const navigateToWallet = useCallback(async (address: string, label?: string) => {
    setIsNavigating(true);
    try {
      const response = await apiRequest("POST", "/api/wallet/temporary", { 
        address, 
        label 
      });
      const data = await response.json();
      
      if (data.id) {
        navigate(`/signal/${data.id}`);
      }
    } catch (error) {
      console.error("Error navigating to wallet:", error);
    } finally {
      setIsNavigating(false);
    }
  }, [navigate]);

  return { navigateToWallet, isNavigating };
}

export async function touchSignalWallet(walletId: number): Promise<void> {
  try {
    await apiRequest("PUT", `/api/signal/${walletId}/touch`);
  } catch (error) {
    console.error("Error touching signal wallet:", error);
  }
}

export async function touchToken(
  tokenMint: string, 
  context?: { 
    aiAnalysisScore?: number; 
    pnlPercent?: number; 
    sourceWalletId?: number;
  }
): Promise<void> {
  try {
    await apiRequest("PUT", `/api/token/${tokenMint}/touch`, context || {});
  } catch (error) {
    console.error("Error touching token:", error);
  }
}
