import { type Swap, type InsertSwap, type NotificationSettings, type MonitoringStatus, type MonitoredWallet, type InsertMonitoredWallet } from "@shared/schema";
import { swaps, settings, monitoringState, monitoredWallets, users, hotWallet, holdings, pendingBuys, tradeConfig } from "@shared/schema";
import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";

const DEFAULT_EMAIL = "";

export interface IStorage {
  getSwaps(userId: number): Promise<Swap[]>;
  getSwapBySignature(signature: string, userId?: number): Promise<Swap | undefined>;
  addSwap(swap: InsertSwap): Promise<Swap>;
  markSwapNotified(id: string): Promise<void>;
  
  getNotificationSettings(userId: number): Promise<NotificationSettings>;
  updateNotificationSettings(userId: number, settings: Partial<NotificationSettings>): Promise<NotificationSettings>;
  
  getMonitoringStatus(): Promise<MonitoringStatus>;
  updateMonitoringStatus(status: Partial<MonitoringStatus>): Promise<MonitoringStatus>;
  
  initialize(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async initialize(): Promise<void> {
    const existingState = await db.select().from(monitoringState).limit(1);
    if (existingState.length === 0) {
      await db.insert(monitoringState).values({
        walletAddress: "",
        isActive: false,
        webhookId: null,
        lastUpdated: Math.floor(Date.now() / 1000),
        totalSwapsDetected: 0,
      });
    }
  }

  async getSwaps(userId: number): Promise<Swap[]> {
    const rows = await db.select().from(swaps).where(eq(swaps.userId, userId)).orderBy(desc(swaps.timestamp));
    return rows.map(row => ({
      id: String(row.id),
      signature: row.signature,
      timestamp: row.timestamp,
      type: row.type,
      source: row.source,
      fromToken: row.fromToken,
      fromTokenSymbol: row.fromTokenSymbol,
      fromAmount: row.fromAmount,
      toToken: row.toToken,
      toTokenSymbol: row.toTokenSymbol,
      toAmount: row.toAmount,
      fee: row.fee ?? undefined,
      slot: row.slot,
      notificationSent: row.notificationSent ?? false,
      toTokenMetadata: row.toTokenMetadata as any,
    }));
  }

  async getSwapBySignature(signature: string, userId?: number): Promise<Swap | undefined> {
    const conditions = userId 
      ? and(eq(swaps.signature, signature), eq(swaps.userId, userId))
      : eq(swaps.signature, signature);
    const rows = await db.select().from(swaps).where(conditions).limit(1);
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      id: String(row.id),
      userId: row.userId ?? undefined,
      signature: row.signature,
      timestamp: row.timestamp,
      type: row.type,
      source: row.source,
      fromToken: row.fromToken,
      fromTokenSymbol: row.fromTokenSymbol,
      fromAmount: row.fromAmount,
      toToken: row.toToken,
      toTokenSymbol: row.toTokenSymbol,
      toAmount: row.toAmount,
      fee: row.fee ?? undefined,
      slot: row.slot,
      notificationSent: row.notificationSent ?? false,
      toTokenMetadata: row.toTokenMetadata as any,
    };
  }

  async addSwap(swap: InsertSwap): Promise<Swap> {
    const [row] = await db.insert(swaps).values({
      userId: swap.userId ?? null,
      signature: swap.signature,
      timestamp: swap.timestamp,
      type: swap.type,
      source: swap.source,
      fromToken: swap.fromToken,
      fromTokenSymbol: swap.fromTokenSymbol,
      fromAmount: swap.fromAmount,
      toToken: swap.toToken,
      toTokenSymbol: swap.toTokenSymbol,
      toAmount: swap.toAmount,
      fee: swap.fee ?? null,
      slot: swap.slot,
      notificationSent: false,
      toTokenMetadata: swap.toTokenMetadata ?? null,
    }).returning();
    
    const count = await db.select().from(swaps);
    await this.updateMonitoringStatus({ totalSwapsDetected: count.length });
    
    return {
      id: String(row.id),
      signature: row.signature,
      timestamp: row.timestamp,
      type: row.type,
      source: row.source,
      fromToken: row.fromToken,
      fromTokenSymbol: row.fromTokenSymbol,
      fromAmount: row.fromAmount,
      toToken: row.toToken,
      toTokenSymbol: row.toTokenSymbol,
      toAmount: row.toAmount,
      fee: row.fee ?? undefined,
      slot: row.slot,
      notificationSent: row.notificationSent ?? false,
      toTokenMetadata: row.toTokenMetadata as any,
    };
  }

  async markSwapNotified(id: string): Promise<void> {
    await db.update(swaps).set({ notificationSent: true }).where(eq(swaps.id, parseInt(id)));
  }

  async getNotificationSettings(userId: number): Promise<NotificationSettings> {
    const rows = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
    if (rows.length === 0) {
      const result = await db.insert(settings).values({
        userId: userId,
        email: DEFAULT_EMAIL,
        emails: [],
        enabled: true,
        minSwapAmount: null,
      }).returning();
      return {
        email: result[0].email,
        emails: [],
        enabled: true,
      };
    }
    const row = rows[0];
    return {
      email: row.email,
      emails: (row.emails as string[]) ?? [],
      enabled: row.enabled ?? true,
      minSwapAmount: row.minSwapAmount ?? undefined,
    };
  }

  async updateNotificationSettings(userId: number, updates: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const rows = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
    if (rows.length === 0) {
      await this.getNotificationSettings(userId);
    }
    const currentRow = rows[0] || (await db.select().from(settings).where(eq(settings.userId, userId)).limit(1))[0];
    
    const current = await this.getNotificationSettings(userId);
    const updated = { ...current, ...updates };
    
    await db.update(settings).set({
      email: updated.email,
      emails: updated.emails,
      enabled: updated.enabled,
      minSwapAmount: updated.minSwapAmount ?? null,
    }).where(eq(settings.id, currentRow.id));
    
    return updated;
  }

  async getMonitoringStatus(): Promise<MonitoringStatus> {
    const rows = await db.select().from(monitoringState).limit(1);
    if (rows.length === 0) {
      return {
        walletAddress: "",
        isActive: false,
        lastUpdated: Date.now(),
        totalSwapsDetected: 0,
      };
    }
    const row = rows[0];
    return {
      walletAddress: row.walletAddress,
      isActive: row.isActive ?? false,
      webhookId: row.webhookId ?? undefined,
      lastUpdated: row.lastUpdated * 1000,
      totalSwapsDetected: row.totalSwapsDetected ?? 0,
    };
  }

  async updateMonitoringStatus(updates: Partial<MonitoringStatus>): Promise<MonitoringStatus> {
    const rows = await db.select().from(monitoringState).limit(1);
    if (rows.length === 0) {
      await this.initialize();
    }
    const currentRow = rows[0] || (await db.select().from(monitoringState).limit(1))[0];
    
    const current = await this.getMonitoringStatus();
    const updated = { ...current, ...updates, lastUpdated: Date.now() };
    
    await db.update(monitoringState).set({
      walletAddress: updated.walletAddress,
      isActive: updated.isActive,
      webhookId: updated.webhookId ?? null,
      lastUpdated: Math.floor(updated.lastUpdated / 1000),
      totalSwapsDetected: updated.totalSwapsDetected,
    }).where(eq(monitoringState.id, currentRow.id));
    
    return updated;
  }

  async getMonitoredWallets(userId: number): Promise<MonitoredWallet[]> {
    return await db.select().from(monitoredWallets).where(eq(monitoredWallets.userId, userId));
  }

  async addMonitoredWallet(userId: number, walletAddress: string, label?: string): Promise<MonitoredWallet> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await db.insert(monitoredWallets).values({
      userId,
      walletAddress,
      label: label || null,
      enabled: true,
      createdAt: now,
    }).returning();
    return rows[0];
  }

  async updateMonitoredWallet(userId: number, walletId: number, updates: { label?: string; enabled?: boolean }): Promise<MonitoredWallet | null> {
    const rows = await db.update(monitoredWallets)
      .set(updates)
      .where(and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, userId)))
      .returning();
    return rows[0] || null;
  }

  async deleteMonitoredWallet(userId: number, walletId: number): Promise<boolean> {
    const rows = await db.delete(monitoredWallets)
      .where(and(eq(monitoredWallets.id, walletId), eq(monitoredWallets.userId, userId)))
      .returning();
    return rows.length > 0;
  }

  async getAllMonitoredWallets(): Promise<MonitoredWallet[]> {
    return await db.select().from(monitoredWallets).where(eq(monitoredWallets.enabled, true));
  }

  async getUserIdByWalletAddress(walletAddress: string): Promise<number | null> {
    const rows = await db.select().from(monitoredWallets)
      .where(and(
        eq(monitoredWallets.walletAddress, walletAddress), 
        eq(monitoredWallets.enabled, true)
      ))
      .limit(1);
    return rows.length > 0 ? rows[0].userId : null;
  }

  async getAllEnabledMonitoredWallets(): Promise<MonitoredWallet[]> {
    return await db.select().from(monitoredWallets).where(eq(monitoredWallets.enabled, true));
  }

  // Admin functions
  async getAllUsers(): Promise<Array<{ id: number; username: string; isAdmin: boolean; createdAt: number; lastLoginAt: number | null }>> {
    const rows = await db.select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    }).from(users);
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      isAdmin: r.isAdmin ?? false,
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
    }));
  }

  async deleteUser(userId: number): Promise<boolean> {
    // Delete all user data
    await db.delete(monitoredWallets).where(eq(monitoredWallets.userId, userId));
    await db.delete(swaps).where(eq(swaps.userId, userId));
    await db.delete(settings).where(eq(settings.userId, userId));
    await db.delete(hotWallet).where(eq(hotWallet.userId, userId));
    await db.delete(holdings).where(eq(holdings.userId, userId));
    await db.delete(pendingBuys).where(eq(pendingBuys.userId, userId));
    await db.delete(tradeConfig).where(eq(tradeConfig.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    return true;
  }

  async getAllWalletsAdmin(): Promise<Array<{ id: number; userId: number; username: string; walletAddress: string; label: string | null; enabled: boolean }>> {
    const rows = await db.select({
      id: monitoredWallets.id,
      userId: monitoredWallets.userId,
      walletAddress: monitoredWallets.walletAddress,
      label: monitoredWallets.label,
      enabled: monitoredWallets.enabled,
    }).from(monitoredWallets);
    
    // Get usernames for each wallet
    const userRows = await db.select({ id: users.id, username: users.username }).from(users);
    const userMap = new Map(userRows.map(u => [u.id, u.username]));
    
    return rows.map(r => ({
      id: r.id,
      userId: r.userId,
      username: userMap.get(r.userId) ?? "Unknown",
      walletAddress: r.walletAddress,
      label: r.label,
      enabled: r.enabled ?? true,
    }));
  }

  async getAdminStats(): Promise<{ totalUsers: number; totalSwaps: number; totalWallets: number; activeWallets: number }> {
    const userRows = await db.select().from(users);
    const swapRows = await db.select().from(swaps);
    const walletRows = await db.select().from(monitoredWallets);
    const activeWalletRows = await db.select().from(monitoredWallets).where(eq(monitoredWallets.enabled, true));
    
    return {
      totalUsers: userRows.length,
      totalSwaps: swapRows.length,
      totalWallets: walletRows.length,
      activeWallets: activeWalletRows.length,
    };
  }
}

export const storage = new DatabaseStorage();
