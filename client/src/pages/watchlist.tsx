import { MonitoredWallets } from "@/components/monitored-wallets";
import { CommunityWallets } from "@/components/community-wallets";

export default function WatchlistPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Signal Wallets</h1>
        <p className="text-muted-foreground">Manage wallets you follow for trade signals</p>
      </div>

      <MonitoredWallets />
      <CommunityWallets />
    </div>
  );
}
