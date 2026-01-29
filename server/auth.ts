import { db } from "./db";
import { users, settings, passwordResetTokens } from "@shared/schema";
import { eq, sql, and } from "drizzle-orm";
import crypto from "crypto";

const SESSION_DURATION_SHORT = 24 * 60 * 60 * 1000; // 1 day
const SESSION_DURATION_LONG = 30 * 24 * 60 * 60 * 1000; // 30 days

interface Session {
  userId: number;
  username: string;
  isAdmin: boolean;
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

export async function createUser(
  username: string, 
  password: string,
  defaultCashoutWallet?: string,
  isAdmin?: boolean
): Promise<{ success: boolean; error?: string; userId?: number }> {
  try {
    // Check username uniqueness case-insensitively
    const existing = await db.select().from(users)
      .where(sql`LOWER(${users.username}) = LOWER(${username})`)
      .limit(1);
    if (existing.length > 0) {
      return { success: false, error: "Username already exists" };
    }

    const passwordHash = hashPassword(password);
    const now = Math.floor(Date.now() / 1000);
    
    const result = await db.insert(users).values({
      username,
      passwordHash,
      createdAt: now,
      defaultCashoutWallet: defaultCashoutWallet || null,
      isAdmin: isAdmin ?? false,
    }).returning({ id: users.id });

    return { success: true, userId: result[0].id };
  } catch (error) {
    console.error("Error creating user:", error);
    return { success: false, error: "Failed to create user" };
  }
}

export async function authenticateUser(username: string, password: string): Promise<{ success: boolean; userId?: number; isAdmin?: boolean; error?: string }> {
  try {
    // Login is case-sensitive
    const userRows = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (userRows.length === 0) {
      return { success: false, error: "Invalid username or password" };
    }

    const user = userRows[0];
    if (!verifyPassword(password, user.passwordHash)) {
      return { success: false, error: "Invalid username or password" };
    }

    await db.update(users).set({ lastLoginAt: Math.floor(Date.now() / 1000) }).where(eq(users.id, user.id));

    return { success: true, userId: user.id, isAdmin: user.isAdmin ?? false };
  } catch (error) {
    console.error("Error authenticating user:", error);
    return { success: false, error: "Authentication failed" };
  }
}

export function createSession(userId: number, username: string, isAdmin: boolean, rememberMe: boolean): string {
  const token = generateSessionToken();
  const expiresAt = Date.now() + (rememberMe ? SESSION_DURATION_LONG : SESSION_DURATION_SHORT);
  
  sessions.set(token, { userId, username, isAdmin, expiresAt });
  
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

const RESET_TOKEN_EXPIRY = 15 * 60 * 1000; // 15 minutes

function generateResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// Constant-time comparison to prevent timing attacks
function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function findUserByEmail(email: string): Promise<{ userId: number; username: string } | null> {
  // Look up user by their recovery email in settings
  const settingsRows = await db.select()
    .from(settings)
    .where(eq(settings.email, email))
    .limit(1);
  
  if (settingsRows.length === 0) {
    // Also check emails array for additional emails
    const allSettings = await db.select().from(settings);
    for (const s of allSettings) {
      if (s.emails && Array.isArray(s.emails) && s.emails.includes(email)) {
        const user = await getUserById(s.userId!);
        if (user) return { userId: user.id, username: user.username };
      }
    }
    return null;
  }

  const userId = settingsRows[0].userId;
  if (!userId) return null;
  
  const user = await getUserById(userId);
  if (!user) return null;
  
  return { userId: user.id, username: user.username };
}

export async function createPasswordResetToken(userId: number): Promise<string> {
  const token = generateResetToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.floor((Date.now() + RESET_TOKEN_EXPIRY) / 1000);

  // Invalidate any existing tokens for this user
  await db.update(passwordResetTokens)
    .set({ used: true })
    .where(eq(passwordResetTokens.userId, userId));

  // Create new token
  await db.insert(passwordResetTokens).values({
    userId,
    token,
    expiresAt,
    used: false,
    createdAt: now,
  });

  return token;
}

export async function validateResetToken(token: string): Promise<{ valid: boolean; userId?: number; error?: string }> {
  const now = Math.floor(Date.now() / 1000);
  
  const tokenRows = await db.select()
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.token, token))
    .limit(1);

  if (tokenRows.length === 0) {
    return { valid: false, error: "Invalid or expired reset link" };
  }

  const resetToken = tokenRows[0];

  if (resetToken.used) {
    return { valid: false, error: "This reset link has already been used" };
  }

  if (resetToken.expiresAt < now) {
    return { valid: false, error: "This reset link has expired" };
  }

  return { valid: true, userId: resetToken.userId };
}

export async function resetPassword(token: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  const validation = await validateResetToken(token);
  
  if (!validation.valid || !validation.userId) {
    return { success: false, error: validation.error || "Invalid token" };
  }

  try {
    const passwordHash = hashPassword(newPassword);
    
    // Update user's password
    await db.update(users)
      .set({ passwordHash })
      .where(eq(users.id, validation.userId));

    // Mark token as used
    await db.update(passwordResetTokens)
      .set({ used: true })
      .where(eq(passwordResetTokens.token, token));

    return { success: true };
  } catch (error) {
    console.error("Error resetting password:", error);
    return { success: false, error: "Failed to reset password" };
  }
}
