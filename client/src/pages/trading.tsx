import { CopyTrading } from "@/components/copy-trading";

export default function TradingPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Trading</h1>
        <p className="text-muted-foreground">Manage your positions and copy trading</p>
      </div>

      <CopyTrading />
    </div>
  );
}
