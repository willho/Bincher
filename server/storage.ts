import { type Swap, type InsertSwap, type NotificationSettings, type MonitoringStatus } from "@shared/schema";
import { swaps, settings, monitoringState } from "@shared/schema";
import { db } from "./db";
import { eq, desc } from "drizzle-orm";

const WALLET_ADDRESS = "C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak";
const DEFAULT_EMAIL = "will728@gmail.com";

export interface IStorage {
  getSwaps(): Promise<Swap[]>;
  getSwapBySignature(signature: string): Promise<Swap | undefined>;
  addSwap(swap: InsertSwap): Promise<Swap>;
  markSwapNotified(id: string): Promise<void>;
  
  getNotificationSettings(): Promise<NotificationSettings>;
  updateNotificationSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings>;
  
  getMonitoringStatus(): Promise<MonitoringStatus>;
  updateMonitoringStatus(status: Partial<MonitoringStatus>): Promise<MonitoringStatus>;
  
  initialize(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async initialize(): Promise<void> {
    const existingSettings = await db.select().from(settings).limit(1);
    if (existingSettings.length === 0) {
      await db.insert(settings).values({
        email: DEFAULT_EMAIL,
        emails: [DEFAULT_EMAIL],
        enabled: true,
        minSwapAmount: null,
      });
    }
    
    const existingState = await db.select().from(monitoringState).limit(1);
    if (existingState.length === 0) {
      await db.insert(monitoringState).values({
        walletAddress: WALLET_ADDRESS,
        isActive: false,
        webhookId: null,
        lastUpdated: Math.floor(Date.now() / 1000),
        totalSwapsDetected: 0,
      });
    }
  }

  async getSwaps(): Promise<Swap[]> {
    const rows = await db.select().from(swaps).orderBy(desc(swaps.timestamp));
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

  async getSwapBySignature(signature: string): Promise<Swap | undefined> {
    const rows = await db.select().from(swaps).where(eq(swaps.signature, signature)).limit(1);
    if (rows.length === 0) return undefined;
    const row = rows[0];
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

  async addSwap(swap: InsertSwap): Promise<Swap> {
    const [row] = await db.insert(swaps).values({
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

  async getNotificationSettings(): Promise<NotificationSettings> {
    const rows = await db.select().from(settings).limit(1);
    if (rows.length === 0) {
      return { email: DEFAULT_EMAIL, emails: [DEFAULT_EMAIL], enabled: true };
    }
    const row = rows[0];
    return {
      email: row.email,
      emails: (row.emails as string[]) ?? [row.email],
      enabled: row.enabled ?? true,
      minSwapAmount: row.minSwapAmount ?? undefined,
    };
  }

  async updateNotificationSettings(updates: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const rows = await db.select().from(settings).limit(1);
    if (rows.length === 0) {
      await this.initialize();
    }
    const currentRow = rows[0] || (await db.select().from(settings).limit(1))[0];
    
    const current = await this.getNotificationSettings();
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
        walletAddress: WALLET_ADDRESS,
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
}

export const storage = new DatabaseStorage();
