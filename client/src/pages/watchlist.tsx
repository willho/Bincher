import { MonitoredWallets } from "@/components/monitored-wallets";
import { CommunityWallets } from "@/components/community-wallets";

export default function WatchlistPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-page-title">Watchlist</h1>
        <p className="text-muted-foreground">Manage your monitored wallets</p>
      </div>

      <MonitoredWallets />
      <CommunityWallets />
    </div>
  );
}
