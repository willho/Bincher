import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const SESSION_DURATION_SHORT = 24 * 60 * 60 * 1000; // 1 day
const SESSION_DURATION_LONG = 30 * 24 * 60 * 60 * 1000; // 30 days

interface Session {
  userId: number;
  username: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return hash === verifyHash;
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createUser(username: string, password: string): Promise<{ success: boolean; error?: string; userId?: number }> {
  try {
    const existing = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existing.length > 0) {
      return { success: false, error: "Username already exists" };
    }

    const passwordHash = hashPassword(password);
    const now = Math.floor(Date.now() / 1000);
    
    const result = await db.insert(users).values({
      username,
      passwordHash,
      createdAt: now,
    }).returning({ id: users.id });

    return { success: true, userId: result[0].id };
  } catch (error) {
    console.error("Error creating user:", error);
    return { success: false, error: "Failed to create user" };
  }
}

export async function authenticateUser(username: string, password: string): Promise<{ success: boolean; userId?: number; error?: string }> {
  try {
    const userRows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (userRows.length === 0) {
      return { success: false, error: "Invalid username or password" };
    }

    const user = userRows[0];
    if (!verifyPassword(password, user.passwordHash)) {
      return { success: false, error: "Invalid username or password" };
    }

    await db.update(users).set({ lastLoginAt: Math.floor(Date.now() / 1000) }).where(eq(users.id, user.id));

    return { success: true, userId: user.id };
  } catch (error) {
    console.error("Error authenticating user:", error);
    return { success: false, error: "Authentication failed" };
  }
}

export function createSession(userId: number, username: string, rememberMe: boolean): string {
  const token = generateSessionToken();
  const expiresAt = Date.now() + (rememberMe ? SESSION_DURATION_LONG : SESSION_DURATION_SHORT);
  
  sessions.set(token, { userId, username, expiresAt });
  
  return token;
}

export function getSession(token: string): Session | null {
  const session = sessions.get(token);
  if (!session) return null;
  
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  
  return session;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export async function getUserCount(): Promise<number> {
  const result = await db.select().from(users);
  return result.length;
}

export async function getUserById(userId: number): Promise<typeof users.$inferSelect | null> {
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return result.length > 0 ? result[0] : null;
}
