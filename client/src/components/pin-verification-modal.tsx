import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Lock, AlertCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface PinVerificationModalProps {
  open: boolean;
  onClose: () => void;
  onVerified: (pin: string) => void;
  actionDescription?: string;
}

export function PinVerificationModal({ 
  open, 
  onClose, 
  onVerified,
  actionDescription = "this action"
}: PinVerificationModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPin("");
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (pin.length < 4 || pin.length > 6) {
      setError("PIN must be 4-6 digits");
      return;
    }

    setVerifying(true);
    setError(null);

    try {
      const response = await apiRequest("POST", "/api/settings/security/verify-pin", { pin });
      const data = await response.json();
      
      if (data.valid) {
        onVerified(pin);
        onClose();
      } else {
        setError("Incorrect PIN. Please try again.");
        setPin("");
        inputRef.current?.focus();
      }
    } catch (err) {
      setError("Failed to verify PIN. Please try again.");
    } finally {
      setVerifying(false);
    }
  };

  const handlePinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, "").slice(0, 6);
    setPin(value);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            PIN Required
          </DialogTitle>
          <DialogDescription>
            Enter your security PIN to confirm {actionDescription}.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Enter PIN"
              value={pin}
              onChange={handlePinChange}
              maxLength={6}
              className="text-center text-2xl tracking-widest"
              disabled={verifying}
              data-testid="input-pin-verify"
            />
            
            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={verifying}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={verifying || pin.length < 4}
              className="flex-1"
              data-testid="button-verify-pin"
            >
              {verifying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Verify
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
