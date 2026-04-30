import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Key, Plus, Trash2, CheckCircle, XCircle, RefreshCw, Wallet, Info } from "lucide-react";

interface UserApiKey {
  id: number;
  service: string;
  keyLabel: string | null;
  isValid: boolean | null;
  lastValidatedAt: number | null;
  createdAt: number;
}

interface WalletLimits {
  limit: number;
  current: number;
  remaining: number;
  validApiKeys: number;
  breakdown: {
    base: number;
    bonus: number;
    max: number;
  };
}

export function ApiKeysSettings() {
  const { toast } = useToast();
  const [newService, setNewService] = useState<string>("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  const { data: keys, isLoading: keysLoading } = useQuery<UserApiKey[]>({
    queryKey: ["/api/api-keys"],
  });

  const { data: limits, isLoading: limitsLoading } = useQuery<WalletLimits>({
    queryKey: ["/api/wallet-limits"],
  });

  const addKeyMutation = useMutation({
    mutationFn: async (data: { service: string; apiKey: string; keyLabel?: string }) => {
      const res = await apiRequest("POST", "/api/api-keys", data);
      return res.json();
    },
    onSuccess: (data: { isValid: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet-limits"] });
      setNewService("");
      setNewApiKey("");
      setNewKeyLabel("");
      setShowAddForm(false);
      toast({
        title: data.isValid ? "API key added" : "API key added (invalid)",
        description: data.isValid 
          ? "Your wallet limit has been increased!"
          : "The key was added but validation failed. Check if the key is correct.",
        variant: data.isValid ? "default" : "destructive",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to add API key",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: async (keyId: number) => {
      return apiRequest("DELETE", `/api/api-keys/${keyId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet-limits"] });
      toast({ title: "API key removed" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to remove API key",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const validateKeyMutation = useMutation({
    mutationFn: async (keyId: number) => {
      const res = await apiRequest("POST", `/api/api-keys/${keyId}/validate`);
      return res.json();
    },
    onSuccess: (data: { isValid: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet-limits"] });
      toast({
        title: data.isValid ? "Key validated" : "Key invalid",
        description: data.isValid 
          ? "Your API key is working correctly."
          : "The key validation failed. Please check if the key is still active.",
        variant: data.isValid ? "default" : "destructive",
      });
    },
  });

  const handleAddKey = () => {
    if (!newService || !newApiKey) {
      toast({
        title: "Missing information",
        description: "Please select a service and enter an API key.",
        variant: "destructive",
      });
      return;
    }
    addKeyMutation.mutate({
      service: newService,
      apiKey: newApiKey,
      keyLabel: newKeyLabel || undefined,
    });
  };

  const walletUsagePercent = limits ? (limits.current / limits.limit) * 100 : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Wallet Limits
          </CardTitle>
          <CardDescription>
            Add your own API keys to increase the number of wallets you can monitor
          </CardDescription>
        </CardHeader>
        <CardContent>
          {limitsLoading ? (
            <div className="animate-pulse h-20 bg-muted rounded" />
          ) : limits ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Signal Wallets</span>
                <span className="font-medium">{limits.current} / {limits.limit}</span>
              </div>
              <Progress value={walletUsagePercent} className="h-2" />
              
              <div className="grid grid-cols-3 gap-4 text-center text-sm">
                <div className="bg-muted/50 rounded-lg p-2">
                  <div className="font-medium">{limits.breakdown.base}</div>
                  <div className="text-xs text-muted-foreground">Base</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-2">
                  <div className="font-medium text-green-500">+{limits.breakdown.bonus}</div>
                  <div className="text-xs text-muted-foreground">API Bonus</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-2">
                  <div className="font-medium">{limits.remaining}</div>
                  <div className="text-xs text-muted-foreground">Remaining</div>
                </div>
              </div>
              
              {limits.validApiKeys > 0 && (
                <div className="flex items-center gap-2 text-sm text-green-500">
                  <CheckCircle className="h-4 w-4" />
                  <span>{limits.validApiKeys} valid API key(s) providing +{limits.breakdown.bonus} wallet slots</span>
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Your API Keys
          </CardTitle>
          <CardDescription className="flex items-center gap-1">
            <Info className="h-3 w-3" />
            Each valid API key grants +2 additional wallet slots
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {keysLoading ? (
            <div className="animate-pulse h-20 bg-muted rounded" />
          ) : keys && keys.length > 0 ? (
            <div className="space-y-2">
              {keys.map((key) => (
                <div
                  key={key.id}
                  data-testid={`api-key-row-${key.id}`}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <Key className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium text-sm">{key.keyLabel || key.service}</div>
                      <div className="text-xs text-muted-foreground capitalize">{key.service}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={key.isValid ? "default" : "destructive"}>
                      {key.isValid ? (
                        <><CheckCircle className="h-3 w-3 mr-1" /> Valid</>
                      ) : (
                        <><XCircle className="h-3 w-3 mr-1" /> Invalid</>
                      )}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => validateKeyMutation.mutate(key.id)}
                      disabled={validateKeyMutation.isPending}
                      data-testid={`button-validate-key-${key.id}`}
                    >
                      <RefreshCw className={`h-4 w-4 ${validateKeyMutation.isPending ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteKeyMutation.mutate(key.id)}
                      disabled={deleteKeyMutation.isPending}
                      data-testid={`button-delete-key-${key.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No API keys added yet</p>
              <p className="text-xs mt-1">Add your own Helius or DexScreener API key to increase wallet limits</p>
            </div>
          )}

          {showAddForm ? (
            <div className="border rounded-lg p-4 space-y-3">
              <div className="space-y-2">
                <Label>Service</Label>
                <Select value={newService} onValueChange={setNewService}>
                  <SelectTrigger data-testid="select-service">
                    <SelectValue placeholder="Select service" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="helius">Helius (Solana RPC)</SelectItem>
                    <SelectItem value="dexscreener">DexScreener (Price Data)</SelectItem>
                    <SelectItem value="resend">Resend (Email Notifications)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="Enter your API key"
                  data-testid="input-api-key"
                />
              </div>
              
              <div className="space-y-2">
                <Label>Label (optional)</Label>
                <Input
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder="e.g., My Helius Key"
                  data-testid="input-key-label"
                />
              </div>
              
              <div className="flex gap-2">
                <Button 
                  onClick={handleAddKey} 
                  disabled={addKeyMutation.isPending}
                  data-testid="button-save-key"
                >
                  {addKeyMutation.isPending ? "Adding..." : "Add Key"}
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => setShowAddForm(false)}
                  data-testid="button-cancel-add"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button 
              variant="outline" 
              className="w-full" 
              onClick={() => setShowAddForm(true)}
              data-testid="button-add-api-key"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add API Key
            </Button>
          )}

          <div className="text-xs text-muted-foreground bg-muted/30 rounded p-3 space-y-1">
            <p><strong>Get free API keys:</strong></p>
            <p>Helius: <a href="https://dev.helius.xyz" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">dev.helius.xyz</a> (free tier: 30 req/s)</p>
            <p>DexScreener: Generally rate-limited for anonymous use</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
