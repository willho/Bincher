import { type Swap, type InsertSwap, type NotificationSettings, type MonitoringStatus } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Swaps
  getSwaps(): Promise<Swap[]>;
  getSwapBySignature(signature: string): Promise<Swap | undefined>;
  addSwap(swap: InsertSwap): Promise<Swap>;
  markSwapNotified(id: string): Promise<void>;
  
  // Notification settings
  getNotificationSettings(): Promise<NotificationSettings>;
  updateNotificationSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings>;
  
  // Monitoring status
  getMonitoringStatus(): Promise<MonitoringStatus>;
  updateMonitoringStatus(status: Partial<MonitoringStatus>): Promise<MonitoringStatus>;
}

export class MemStorage implements IStorage {
  private swaps: Map<string, Swap>;
  private notificationSettings: NotificationSettings;
  private monitoringStatus: MonitoringStatus;

  constructor() {
    this.swaps = new Map();
    this.notificationSettings = {
      email: "will728@gmail.com",
      enabled: true,
      minSwapAmount: undefined,
    };
    this.monitoringStatus = {
      walletAddress: "C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak",
      isActive: false,
      webhookId: undefined,
      lastUpdated: Date.now(),
      totalSwapsDetected: 0,
    };
  }

  async getSwaps(): Promise<Swap[]> {
    return Array.from(this.swaps.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  async getSwapBySignature(signature: string): Promise<Swap | undefined> {
    return Array.from(this.swaps.values()).find(s => s.signature === signature);
  }

  async addSwap(swap: InsertSwap): Promise<Swap> {
    const id = randomUUID();
    const newSwap: Swap = { ...swap, id, notificationSent: false };
    this.swaps.set(id, newSwap);
    this.monitoringStatus.totalSwapsDetected = this.swaps.size;
    this.monitoringStatus.lastUpdated = Date.now();
    return newSwap;
  }

  async markSwapNotified(id: string): Promise<void> {
    const swap = this.swaps.get(id);
    if (swap) {
      swap.notificationSent = true;
      this.swaps.set(id, swap);
    }
  }

  async getNotificationSettings(): Promise<NotificationSettings> {
    return this.notificationSettings;
  }

  async updateNotificationSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings> {
    this.notificationSettings = { ...this.notificationSettings, ...settings };
    return this.notificationSettings;
  }

  async getMonitoringStatus(): Promise<MonitoringStatus> {
    return this.monitoringStatus;
  }

  async updateMonitoringStatus(status: Partial<MonitoringStatus>): Promise<MonitoringStatus> {
    this.monitoringStatus = { ...this.monitoringStatus, ...status, lastUpdated: Date.now() };
    return this.monitoringStatus;
  }
}

export const storage = new MemStorage();
