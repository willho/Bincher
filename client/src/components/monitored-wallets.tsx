import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Copy, Plus, Trash2, Wallet, RefreshCw, Edit2, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface MonitoredWallet {
  id: number;
  userId: number;
  walletAddress: string;
  label: string | null;
  enabled: boolean | null;
  createdAt: number;
}

export function MonitoredWallets() {
  const [newWalletAddress, setNewWalletAddress] = useState("");
  const [newWalletLabel, setNewWalletLabel] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const { toast } = useToast();

  const { data: wallets, isLoading } = useQuery<MonitoredWallet[]>({
    queryKey: ["/api/monitored-wallets"],
  });

  const addWallet = useMutation({
    mutationFn: (data: { walletAddress: string; label?: string }) =>
      apiRequest("POST", "/api/monitored-wallets", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      setNewWalletAddress("");
      setNewWalletLabel("");
      toast({ description: "Wallet added successfully" });
      syncWebhook.mutate();
    },
    onError: (error: any) => {
      toast({ description: error.message || "Failed to add wallet", variant: "destructive" });
    },
  });

  const updateWallet = useMutation({
    mutationFn: ({ id, ...data }: { id: number; label?: string; enabled?: boolean }) =>
      apiRequest("PATCH", `/api/monitored-wallets/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      setEditingId(null);
      toast({ description: "Wallet updated" });
      syncWebhook.mutate();
    },
  });

  const deleteWallet = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/monitored-wallets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/monitored-wallets"] });
      toast({ description: "Wallet removed" });
      syncWebhook.mutate();
    },
  });

  const syncWebhook = useMutation({
    mutationFn: () => apiRequest("POST", "/api/monitored-wallets/sync"),
  });

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ description: "Address copied" });
    } catch {
      toast({ description: "Failed to copy", variant: "destructive" });
    }
  };

  const handleAddWallet = () => {
    if (!newWalletAddress.trim()) {
      toast({ description: "Please enter a wallet address", variant: "destructive" });
      return;
    }
    addWallet.mutate({ 
      walletAddress: newWalletAddress.trim(), 
      label: newWalletLabel.trim() || undefined 
    });
  };

  const startEditing = (wallet: MonitoredWallet) => {
    setEditingId(wallet.id);
    setEditLabel(wallet.label || "");
  };

  const saveEdit = (id: number) => {
    updateWallet.mutate({ id, label: editLabel });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Monitored Wallets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Monitored Wallets
        </CardTitle>
        <CardDescription>
          Add Solana wallet addresses to monitor for swaps. All your wallets are monitored for copy trading.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="wallet-address">Wallet Address</Label>
            <Input
              id="wallet-address"
              data-testid="input-wallet-address"
              placeholder="Enter Solana wallet address"
              value={newWalletAddress}
              onChange={(e) => setNewWalletAddress(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wallet-label">Label (optional)</Label>
            <Input
              id="wallet-label"
              data-testid="input-wallet-label"
              placeholder="e.g., Main Trader, Alpha Wallet"
              value={newWalletLabel}
              onChange={(e) => setNewWalletLabel(e.target.value)}
            />
          </div>
          <Button
            data-testid="button-add-wallet"
            onClick={handleAddWallet}
            disabled={addWallet.isPending}
            className="w-full"
          >
            {addWallet.isPending ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add Wallet
          </Button>
        </div>

        {wallets && wallets.length > 0 && (
          <div className="space-y-2 pt-4 border-t">
            <Label>Your Monitored Wallets</Label>
            {wallets.map((wallet) => (
              <div
                key={wallet.id}
                data-testid={`wallet-item-${wallet.id}`}
                className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  {editingId === wallet.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        placeholder="Enter label"
                        className="h-8"
                        data-testid={`input-edit-label-${wallet.id}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => saveEdit(wallet.id)}
                        data-testid={`button-save-label-${wallet.id}`}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setEditingId(null)}
                        data-testid={`button-cancel-edit-${wallet.id}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">
                          {wallet.label || "Unnamed Wallet"}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => startEditing(wallet)}
                          data-testid={`button-edit-wallet-${wallet.id}`}
                        >
                          <Edit2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground font-mono truncate">
                          {wallet.walletAddress.slice(0, 8)}...{wallet.walletAddress.slice(-6)}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => copyToClipboard(wallet.walletAddress)}
                          data-testid={`button-copy-address-${wallet.id}`}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                <Switch
                  checked={wallet.enabled ?? true}
                  onCheckedChange={(enabled) =>
                    updateWallet.mutate({ id: wallet.id, enabled })
                  }
                  data-testid={`switch-wallet-enabled-${wallet.id}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => deleteWallet.mutate(wallet.id)}
                  disabled={deleteWallet.isPending}
                  data-testid={`button-delete-wallet-${wallet.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {(!wallets || wallets.length === 0) && (
          <div className="text-center py-6 text-muted-foreground">
            <Wallet className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p>No wallets added yet</p>
            <p className="text-sm">Add a wallet address to start monitoring swaps</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
