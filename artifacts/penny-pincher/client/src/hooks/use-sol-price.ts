import { useQuery } from "@tanstack/react-query";

interface SolPriceData {
  priceUsd: number;
  lastUpdated: number;
}

export function useSolPrice() {
  const { data, isLoading, error } = useQuery<SolPriceData>({
    queryKey: ["/api/sol-price"],
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const solToUsd = (sol: number | string | null | undefined): number => {
    if (sol === null || sol === undefined) return 0;
    const solAmount = typeof sol === "string" ? parseFloat(sol) : sol;
    if (isNaN(solAmount)) return 0;
    return solAmount * (data?.priceUsd || 0);
  };

  const formatUsd = (usd: number): string => {
    if (usd >= 1000000) {
      return `$${(usd / 1000000).toFixed(2)}M`;
    }
    if (usd >= 1000) {
      return `$${(usd / 1000).toFixed(2)}K`;
    }
    if (usd >= 1) {
      return `$${usd.toFixed(2)}`;
    }
    return `$${usd.toFixed(4)}`;
  };

  const formatSolWithUsd = (sol: number | string | null | undefined): string => {
    if (sol === null || sol === undefined) return "0 SOL";
    const solAmount = typeof sol === "string" ? parseFloat(sol) : sol;
    if (isNaN(solAmount)) return "0 SOL";
    
    const usd = solToUsd(solAmount);
    const solStr = solAmount < 0.0001 
      ? solAmount.toExponential(2) 
      : solAmount.toFixed(4);
    
    if (!data?.priceUsd) return `${solStr} SOL`;
    return `${solStr} SOL (${formatUsd(usd)})`;
  };

  return {
    priceUsd: data?.priceUsd || 0,
    isLoading,
    error,
    solToUsd,
    formatUsd,
    formatSolWithUsd
  };
}
