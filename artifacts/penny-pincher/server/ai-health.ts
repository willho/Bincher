import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

interface AIHealthStatus {
  available: boolean;
  lastCheck: number;
  lastError?: string;
  consecutiveFailures: number;
  lastSuccessfulCall: number;
}

const healthStatus: AIHealthStatus = {
  available: true,
  lastCheck: Date.now(),
  consecutiveFailures: 0,
  lastSuccessfulCall: Date.now(),
};

const MAX_CONSECUTIVE_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 60000; // 1 minute

export function getAIHealth(): AIHealthStatus {
  return { ...healthStatus };
}

export function isAIAvailable(): boolean {
  return healthStatus.available;
}

export function recordAISuccess(): void {
  healthStatus.available = true;
  healthStatus.lastCheck = Date.now();
  healthStatus.lastSuccessfulCall = Date.now();
  healthStatus.consecutiveFailures = 0;
  healthStatus.lastError = undefined;
}

export function recordAIFailure(error: string): void {
  healthStatus.lastCheck = Date.now();
  healthStatus.consecutiveFailures++;
  healthStatus.lastError = error;
  
  if (healthStatus.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    healthStatus.available = false;
    console.log(`[AI Health] AI marked unavailable after ${healthStatus.consecutiveFailures} failures: ${error}`);
  }
}

export function getUnavailableFeatures(): string[] {
  if (healthStatus.available) return [];
  
  return [
    "Chat with Miss Pincher",
    "Natural language commands",
    "Token analysis and advice",
    "Heat score explanations",
    "AI-generated alerts",
  ];
}

export function getAvailableFeatures(): string[] {
  return [
    "Manual buy/sell trading",
    "Copy trading automation",
    "Take-profit automation",
    "Wallet monitoring",
    "Holdings and balance view",
    "Configuration changes",
    "Telegram alerts for swaps",
  ];
}

export function getFallbackMessage(): string {
  const unavailable = getUnavailableFeatures();
  const available = getAvailableFeatures();
  
  return `Miss Pincher is taking a quick rest. Don't worry - all your trading features still work!\n\n` +
    `**Still working:**\n${available.map(f => `• ${f}`).join('\n')}\n\n` +
    `**Temporarily unavailable:**\n${unavailable.map(f => `• ${f}`).join('\n')}\n\n` +
    `Use the Trading page for manual controls, or try again in a few minutes.`;
}
