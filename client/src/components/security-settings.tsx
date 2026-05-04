import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Lock, Shield, Wallet, AlertTriangle, CheckCircle, Loader2, Plus, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface SecuritySettingsData {
  hasPinSet: boolean;
  pinMode: string;
  pinThresholdUsd: number;
  dailySpendLimitUsd: number | null;
  withdrawalWhitelist: string[];
  telegramConfirmLargeTransfers: boolean;
  largeTransferThresholdUsd: number;
}

export function SecuritySettings() {
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useQuery<SecuritySettingsData>({
    queryKey: ["/api/settings/security"],
  });

  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinMode, setPinMode] = useState<"withdrawals_only" | "all_trades" | "threshold">("withdrawals_only");
  const [pinThreshold, setPinThreshold] = useState("100");
  const [dailyLimit, setDailyLimit] = useState("");
  const [telegramConfirm, setTelegramConfirm] = useState(false);
  const [largeTransferThreshold, setLargeTransferThreshold] = useState("500");
  const [newWhitelistAddress, setNewWhitelistAddress] = useState("");
  const [whitelist, setWhitelist] = useState<string[]>([]);

  useEffect(() => {
    if (settings) {
      setPinMode(settings.pinMode as typeof pinMode);
      setPinThreshold(settings.pinThresholdUsd.toString());
      setDailyLimit(settings.dailySpendLimitUsd?.toString() || "");
      setTelegramConfirm(settings.telegramConfirmLargeTransfers);
      setLargeTransferThreshold(settings.largeTransferThresholdUsd.toString());
      setWhitelist(settings.withdrawalWhitelist || []);
    }
  }, [settings]);

  const setPinMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/settings/security/set-pin", { pin }),
    onSuccess: () => {
      toast({ title: "PIN set successfully" });
      setShowPinSetup(false);
      setPin("");
      setConfirmPin("");
      queryClient.invalidateQueries({ queryKey: ["/api/settings/security"] });
    },
    onError: () => {
      toast({ title: "Failed to set PIN", variant: "destructive" });
    }
  });

  const saveSettingsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/settings/security", {
      pinMode,
      pinThresholdUsd: parseFloat(pinThreshold) || 100,
      dailySpendLimitUsd: dailyLimit ? parseFloat(dailyLimit) : null,
      telegramConfirmLargeTransfers: telegramConfirm,
      largeTransferThresholdUsd: parseFloat(largeTransferThreshold) || 500,
      withdrawalWhitelist: whitelist,
    }),
    onSuccess: () => {
      toast({ title: "Security settings saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/security"] });
    },
    onError: () => {
      toast({ title: "Failed to save settings", variant: "destructive" });
    }
  });

  const addToWhitelist = () => {
    if (newWhitelistAddress && newWhitelistAddress.length >= 32 && !whitelist.includes(newWhitelistAddress)) {
      setWhitelist([...whitelist, newWhitelistAddress]);
      setNewWhitelistAddress("");
    } else if (newWhitelistAddress.length < 32) {
      toast({ title: "Invalid Solana address", variant: "destructive" });
    }
  };

  const removeFromWhitelist = (address: string) => {
    setWhitelist(whitelist.filter(a => a !== address));
  };

  const handleSetPin = () => {
    if (pin.length < 4 || pin.length > 6) {
      toast({ title: "PIN must be 4-6 digits", variant: "destructive" });
      return;
    }
    if (!/^\d+$/.test(pin)) {
      toast({ title: "PIN must contain only numbers", variant: "destructive" });
      return;
    }
    if (pin !== confirmPin) {
      toast({ title: "PINs don't match", variant: "destructive" });
      return;
    }
    setPinMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            PIN Protection
          </CardTitle>
          <CardDescription>
            Require a PIN for trading actions via Miss Pincher
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">PIN Status</p>
              <p className="text-sm text-muted-foreground">
                {settings?.hasPinSet ? "PIN is set and active" : "No PIN configured"}
              </p>
            </div>
            {settings?.hasPinSet ? (
              <Badge variant="default" className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3" />
                Active
              </Badge>
            ) : (
              <Badge variant="outline" className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Not Set
              </Badge>
            )}
          </div>

          {!showPinSetup && (
            <Button 
              onClick={() => setShowPinSetup(true)} 
              variant="outline"
              data-testid="button-setup-pin"
            >
              {settings?.hasPinSet ? "Change PIN" : "Set Up PIN"}
            </Button>
          )}

          {showPinSetup && (
            <div className="space-y-4 p-4 border rounded-lg">
              <div className="space-y-2">
                <Label htmlFor="pin">New PIN (4-6 digits)</Label>
                <Input
                  id="pin"
                  type="password"
                  placeholder="Enter PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  maxLength={6}
                  data-testid="input-pin"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-pin">Confirm PIN</Label>
                <Input
                  id="confirm-pin"
                  type="password"
                  placeholder="Confirm PIN"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  maxLength={6}
                  data-testid="input-confirm-pin"
                />
              </div>
              <div className="flex gap-2">
                <Button 
                  onClick={handleSetPin} 
                  disabled={setPinMutation.isPending}
                  data-testid="button-save-pin"
                >
                  {setPinMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save PIN
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setShowPinSetup(false);
                    setPin("");
                    setConfirmPin("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {settings?.hasPinSet && (
            <>
              <div className="space-y-2">
                <Label>When to Require PIN</Label>
                <Select value={pinMode} onValueChange={(v) => setPinMode(v as typeof pinMode)}>
                  <SelectTrigger data-testid="select-pin-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="withdrawals_only">Withdrawals only</SelectItem>
                    <SelectItem value="all_trades">All trades</SelectItem>
                    <SelectItem value="threshold">Trades over threshold</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {pinMode === "threshold" && (
                <div className="space-y-2">
                  <Label htmlFor="pin-threshold">PIN Required Above ($)</Label>
                  <Input
                    id="pin-threshold"
                    type="number"
                    placeholder="100"
                    value={pinThreshold}
                    onChange={(e) => setPinThreshold(e.target.value)}
                    data-testid="input-pin-threshold"
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Spending Limits
          </CardTitle>
          <CardDescription>
            Control how much can be spent per day
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="daily-limit">Daily Spend Limit ($)</Label>
            <Input
              id="daily-limit"
              type="number"
              placeholder="No limit"
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              data-testid="input-daily-limit"
            />
            <p className="text-xs text-muted-foreground">
              Leave empty for no limit. Miss Pincher will warn you when approaching the limit.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Withdrawal Whitelist
          </CardTitle>
          <CardDescription>
            Only allow withdrawals to these approved addresses
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Solana address..."
              value={newWhitelistAddress}
              onChange={(e) => setNewWhitelistAddress(e.target.value)}
              data-testid="input-whitelist-address"
            />
            <Button 
              size="icon" 
              variant="outline" 
              onClick={addToWhitelist}
              data-testid="button-add-whitelist"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          
          {whitelist.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No addresses whitelisted. Add addresses to restrict withdrawals to approved wallets only.
            </p>
          ) : (
            <div className="space-y-2">
              {whitelist.map((address, i) => (
                <div key={i} className="flex items-center justify-between p-2 bg-muted rounded-md">
                  <code className="text-xs truncate flex-1">{address}</code>
                  <Button 
                    size="icon" 
                    variant="ghost" 
                    onClick={() => removeFromWhitelist(address)}
                    data-testid={`button-remove-whitelist-${i}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Large Transfer Confirmation
          </CardTitle>
          <CardDescription>
            Require Telegram confirmation for large withdrawals
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Telegram Confirmation</p>
              <p className="text-sm text-muted-foreground">
                Get a Telegram message to confirm large transfers
              </p>
            </div>
            <Switch
              checked={telegramConfirm}
              onCheckedChange={setTelegramConfirm}
              data-testid="switch-telegram-confirm"
            />
          </div>

          {telegramConfirm && (
            <div className="space-y-2">
              <Label htmlFor="large-transfer-threshold">Confirm Transfers Above ($)</Label>
              <Input
                id="large-transfer-threshold"
                type="number"
                placeholder="500"
                value={largeTransferThreshold}
                onChange={(e) => setLargeTransferThreshold(e.target.value)}
                data-testid="input-large-transfer-threshold"
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Button 
        onClick={() => saveSettingsMutation.mutate()}
        disabled={saveSettingsMutation.isPending}
        className="w-full"
        data-testid="button-save-security"
      >
        {saveSettingsMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Save Security Settings
      </Button>
    </div>
  );
}
