import { db } from "./db";
import { users, systemLogs, linkTokens, pincherDataRequests, monitoredWallets, holdings, swaps } from "@shared/schema";
import { eq, desc, and, sql, lt } from "drizzle-orm";
import { chatWithAI } from "./ai";
import crypto from "crypto";

const LINK_TOKEN_EXPIRY_SECONDS = 600; // 10 minutes

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export async function log(
  service: string,
  action: string,
  status: "success" | "error" | "warning" | "info",
  options: {
    latencyMs?: number;
    errorMessage?: string;
    errorStack?: string;
    context?: Record<string, any>;
    userId?: number;
  } = {}
) {
  try {
    await db.insert(systemLogs).values({
      service,
      action,
      status,
      latencyMs: options.latencyMs,
      errorMessage: options.errorMessage,
      errorStack: options.errorStack,
      context: options.context,
      userId: options.userId,
      createdAt: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    console.error("[LOG ERROR]", e);
  }
}

async function telegramRequest(method: string, body?: any): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) {
    await log("telegram", method, "error", { errorMessage: "TELEGRAM_BOT_TOKEN not set" });
    return null;
  }

  const start = Date.now();
  try {
    const response = await fetch(`${TELEGRAM_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    const latency = Date.now() - start;

    if (!data.ok) {
      await log("telegram", method, "error", {
        latencyMs: latency,
        errorMessage: data.description,
        context: { body, response: data },
      });
      return null;
    }

    await log("telegram", method, "success", { latencyMs: latency });
    return data.result;
  } catch (e: any) {
    await log("telegram", method, "error", {
      latencyMs: Date.now() - start,
      errorMessage: e.message,
      errorStack: e.stack,
    });
    return null;
  }
}

export async function sendMessage(chatId: string, text: string, options: { parseMode?: string } = {}): Promise<boolean> {
  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode || "Markdown",
  });
  return result !== null;
}

export async function verifyBotToken(): Promise<{ valid: boolean; username?: string; error?: string }> {
  if (!TELEGRAM_BOT_TOKEN) {
    return { valid: false, error: "TELEGRAM_BOT_TOKEN not set" };
  }

  const result = await telegramRequest("getMe", {});
  if (result) {
    return { valid: true, username: result.username };
  }
  return { valid: false, error: "Failed to verify bot token" };
}

export async function setWebhook(url: string): Promise<{ success: boolean; error?: string }> {
  const result = await telegramRequest("setWebhook", {
    url,
    allowed_updates: ["message", "callback_query"],
  });
  if (result) {
    return { success: true };
  }
  return { success: false, error: "Failed to set webhook" };
}

export async function deleteWebhookTg(): Promise<boolean> {
  const result = await telegramRequest("deleteWebhook", {});
  return result !== null;
}

export async function getWebhookInfo(): Promise<any> {
  return await telegramRequest("getWebhookInfo", {});
}

export function generateLinkToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function createLinkToken(userId: number): Promise<string> {
  const token = generateLinkToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + LINK_TOKEN_EXPIRY_SECONDS;
  
  // Clean up any expired tokens first
  await db.delete(linkTokens).where(lt(linkTokens.expiresAt, now));
  
  // Delete any existing tokens for this user
  await db.delete(linkTokens).where(eq(linkTokens.userId, userId));
  
  // Insert new token
  await db.insert(linkTokens).values({
    token,
    userId,
    expiresAt,
    createdAt: now,
  });
  
  await log("telegram", "create_link_token", "info", { userId });
  return token;
}

export async function verifyAndLinkTelegram(
  token: string,
  chatId: string
): Promise<{ success: boolean; username?: string; error?: string }> {
  const now = Math.floor(Date.now() / 1000);
  
  // Find valid (non-expired) token
  const [linkToken] = await db
    .select()
    .from(linkTokens)
    .where(and(eq(linkTokens.token, token), lt(now, linkTokens.expiresAt)))
    .limit(1);

  if (!linkToken) {
    await log("telegram", "link_verify", "warning", { context: { token, chatId, reason: "invalid_or_expired_token" } });
    return { success: false, error: "Invalid or expired link token" };
  }

  // Get the user
  const [user] = await db.select().from(users).where(eq(users.id, linkToken.userId)).limit(1);
  if (!user) {
    await log("telegram", "link_verify", "error", { context: { token, chatId, reason: "user_not_found" } });
    return { success: false, error: "User not found" };
  }

  // Check if chat already linked to different user
  const existingLinked = await db.select().from(users).where(eq(users.telegramChatId, chatId)).limit(1);
  if (existingLinked.length > 0 && existingLinked[0].id !== user.id) {
    await log("telegram", "link_verify", "warning", {
      context: { chatId, reason: "already_linked_different_user" },
      userId: user.id,
    });
    return { success: false, error: "This Telegram account is already linked to another user" };
  }

  // Link the account and delete the token (one-time use)
  await db
    .update(users)
    .set({
      telegramChatId: chatId,
      telegramLinkedAt: now,
    })
    .where(eq(users.id, user.id));
  
  // Delete the used token (one-time use)
  await db.delete(linkTokens).where(eq(linkTokens.id, linkToken.id));

  await log("telegram", "link_success", "success", { userId: user.id, context: { chatId } });
  return { success: true, username: user.username };
}

export async function unlinkTelegram(userId: number): Promise<boolean> {
  await db
    .update(users)
    .set({
      telegramChatId: null,
      telegramLinkedAt: null,
    })
    .where(eq(users.id, userId));
  
  // Also clean up any pending link tokens
  await db.delete(linkTokens).where(eq(linkTokens.userId, userId));
  
  await log("telegram", "unlink", "success", { userId });
  return true;
}

export async function getUserByChatId(chatId: string): Promise<typeof users.$inferSelect | null> {
  const [user] = await db.select().from(users).where(eq(users.telegramChatId, chatId)).limit(1);
  return user || null;
}

async function handleCommand(chatId: string, command: string, args: string, user: typeof users.$inferSelect | null) {
  switch (command) {
    case "/start":
      if (args) {
        const result = await verifyAndLinkTelegram(args, chatId);
        if (result.success) {
          await sendMessage(
            chatId,
            `*Linked successfully!* Welcome, ${result.username}.\n\nI'm Miss Pincher, your AI trading assistant. I'll send you alerts and you can chat with me anytime.\n\nType /help to see available commands.`
          );
        } else {
          await sendMessage(chatId, `Link failed: ${result.error}\n\nGet a new link from the Penny Pincher app.`);
        }
      } else if (user) {
        await sendMessage(chatId, `Welcome back, ${user.username}! Type /help for commands or just chat with me.`);
      } else {
        await sendMessage(
          chatId,
          `Hey there. I'm Miss Pincher.\n\nTo use me, you need to link your Penny Pincher account first. Go to Settings in the app and click "Link Telegram".`
        );
      }
      break;

    case "/help":
      const helpText = user?.isAdmin
        ? `*Commands:*\n\n/status - Your account status\n/wallets - Your monitored wallets\n/holdings - Your current holdings\n/unlink - Unlink Telegram\n\n*Admin:*\n/stats - System statistics\n/users - User list\n/requests - Pending data requests\n/approve [id] - Approve request\n/reject [id] [reason] - Reject request`
        : `*Commands:*\n\n/status - Your account status\n/wallets - Your monitored wallets\n/holdings - Your current holdings\n/unlink - Unlink Telegram\n\nOr just chat with me! I'm here to help with token analysis and trading insights.`;
      await sendMessage(chatId, helpText);
      break;

    case "/status":
      if (!user) {
        await sendMessage(chatId, "You need to link your account first. Go to Settings in the app.");
        return;
      }
      const walletCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(monitoredWallets)
        .where(eq(monitoredWallets.userId, user.id));
      const holdingCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(holdings)
        .where(and(eq(holdings.userId, user.id), eq(holdings.reclaimed, false)));
      await sendMessage(
        chatId,
        `*Status for ${user.username}*\n\nMonitored wallets: ${walletCount[0]?.count || 0}\nActive holdings: ${holdingCount[0]?.count || 0}\nAdmin: ${user.isAdmin ? "Yes" : "No"}\nLinked: ${new Date((user.telegramLinkedAt || 0) * 1000).toLocaleDateString()}`
      );
      break;

    case "/wallets":
      if (!user) {
        await sendMessage(chatId, "Link your account first.");
        return;
      }
      const wallets = await db
        .select()
        .from(monitoredWallets)
        .where(eq(monitoredWallets.userId, user.id))
        .limit(10);
      if (wallets.length === 0) {
        await sendMessage(chatId, "No monitored wallets yet. Add some in the app!");
      } else {
        const list = wallets
          .map((w, i) => `${i + 1}. ${w.label || "Unnamed"}\n   \`${w.walletAddress.slice(0, 8)}...${w.walletAddress.slice(-4)}\``)
          .join("\n\n");
        await sendMessage(chatId, `*Your Wallets:*\n\n${list}`);
      }
      break;

    case "/holdings":
      if (!user) {
        await sendMessage(chatId, "Link your account first.");
        return;
      }
      const userHoldings = await db
        .select()
        .from(holdings)
        .where(and(eq(holdings.userId, user.id), eq(holdings.reclaimed, false)))
        .orderBy(desc(holdings.buyTimestamp))
        .limit(10);
      if (userHoldings.length === 0) {
        await sendMessage(chatId, "No active holdings. Start copy trading to get some!");
      } else {
        const list = userHoldings
          .map((h) => {
            const mult = h.lastPrice && h.buyPrice ? (h.lastPrice / h.buyPrice).toFixed(2) : "?";
            return `*${h.tokenSymbol}*\nBought: ${h.solSpent?.toFixed(3)} SOL\nMultiplier: ${mult}x`;
          })
          .join("\n\n");
        await sendMessage(chatId, `*Active Holdings:*\n\n${list}`);
      }
      break;

    case "/unlink":
      if (!user) {
        await sendMessage(chatId, "You're not linked to any account.");
        return;
      }
      await unlinkTelegram(user.id);
      await sendMessage(chatId, "Account unlinked. You'll no longer receive alerts. Re-link anytime from the app.");
      break;

    case "/stats":
      if (!user?.isAdmin) {
        await sendMessage(chatId, "Admin only.");
        return;
      }
      const totalUsers = await db.select({ count: sql<number>`count(*)` }).from(users);
      const linkedUsers = await db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(sql`${users.telegramChatId} IS NOT NULL`);
      const totalWallets = await db.select({ count: sql<number>`count(*)` }).from(monitoredWallets);
      const recentSwaps = await db
        .select({ count: sql<number>`count(*)` })
        .from(swaps)
        .where(sql`${swaps.timestamp} > ${Math.floor(Date.now() / 1000) - 86400}`);
      await sendMessage(
        chatId,
        `*System Stats:*\n\nUsers: ${totalUsers[0]?.count || 0}\nTelegram linked: ${linkedUsers[0]?.count || 0}\nMonitored wallets: ${totalWallets[0]?.count || 0}\nSwaps (24h): ${recentSwaps[0]?.count || 0}`
      );
      break;

    case "/users":
      if (!user?.isAdmin) {
        await sendMessage(chatId, "Admin only.");
        return;
      }
      const allUsers = await db.select().from(users).limit(20);
      const userList = allUsers
        .map(
          (u) =>
            `${u.username}${u.isAdmin ? " (admin)" : ""}\n  TG: ${u.telegramChatId ? "linked" : "no"}`
        )
        .join("\n");
      await sendMessage(chatId, `*Users:*\n\n${userList}`);
      break;

    case "/requests":
      if (!user?.isAdmin) {
        await sendMessage(chatId, "Admin only.");
        return;
      }
      const pendingReqs = await db
        .select()
        .from(pincherDataRequests)
        .where(eq(pincherDataRequests.status, "pending"))
        .orderBy(desc(pincherDataRequests.createdAt))
        .limit(10);
      if (pendingReqs.length === 0) {
        await sendMessage(chatId, "No pending data requests from Pincher.");
      } else {
        const reqList = pendingReqs
          .map((r) => `*#${r.id}* [${r.priority}]\n${r.requestType}: ${r.description}`)
          .join("\n\n");
        await sendMessage(chatId, `*Pending Requests:*\n\n${reqList}\n\nUse /approve [id] or /reject [id] [reason]`);
      }
      break;

    case "/approve":
      if (!user?.isAdmin) {
        await sendMessage(chatId, "Admin only.");
        return;
      }
      const approveId = parseInt(args);
      if (!approveId) {
        await sendMessage(chatId, "Usage: /approve [id]");
        return;
      }
      await db
        .update(pincherDataRequests)
        .set({ status: "approved", resolvedBy: user.id, resolvedAt: Math.floor(Date.now() / 1000) })
        .where(eq(pincherDataRequests.id, approveId));
      await sendMessage(chatId, `Request #${approveId} approved.`);
      break;

    case "/reject":
      if (!user?.isAdmin) {
        await sendMessage(chatId, "Admin only.");
        return;
      }
      const [rejectIdStr, ...reasonParts] = args.split(" ");
      const rejectId = parseInt(rejectIdStr);
      const reason = reasonParts.join(" ") || "Rejected by admin";
      if (!rejectId) {
        await sendMessage(chatId, "Usage: /reject [id] [reason]");
        return;
      }
      await db
        .update(pincherDataRequests)
        .set({
          status: "rejected",
          adminNotes: reason,
          resolvedBy: user.id,
          resolvedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(pincherDataRequests.id, rejectId));
      await sendMessage(chatId, `Request #${rejectId} rejected: ${reason}`);
      break;

    default:
      if (user) {
        await sendMessage(chatId, `Unknown command. Type /help for available commands.`);
      } else {
        await sendMessage(chatId, `Link your account first to use commands.`);
      }
  }
}

async function handleChatMessage(chatId: string, text: string, user: typeof users.$inferSelect) {
  try {
    await telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });
    const response = await chatWithAI(user.id, text, 'telegram');
    await sendMessage(chatId, response);
  } catch (e: any) {
    await log("telegram", "chat_ai", "error", {
      errorMessage: e.message,
      errorStack: e.stack,
      userId: user.id,
    });
    await sendMessage(chatId, "Sorry, I'm having trouble thinking right now. Try again in a moment.");
  }
}

export async function handleWebhookUpdate(update: any): Promise<void> {
  const start = Date.now();

  try {
    const message = update.message;
    if (!message || !message.chat || !message.text) {
      await log("telegram", "webhook_update", "info", { context: { type: "non_text_message" } });
      return;
    }

    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const user = await getUserByChatId(chatId);

    if (text.startsWith("/")) {
      const [commandWithBot, ...argParts] = text.split(" ");
      const command = commandWithBot.split("@")[0].toLowerCase();
      const args = argParts.join(" ");
      await handleCommand(chatId, command, args, user);
    } else if (user) {
      await handleChatMessage(chatId, text, user);
    } else {
      await sendMessage(chatId, "Hey! Link your Penny Pincher account first. Go to Settings in the app and click 'Link Telegram'.");
    }

    await log("telegram", "webhook_update", "success", { latencyMs: Date.now() - start, userId: user?.id });
  } catch (e: any) {
    await log("telegram", "webhook_update", "error", {
      latencyMs: Date.now() - start,
      errorMessage: e.message,
      errorStack: e.stack,
      context: { update },
    });
  }
}

export async function sendSwapAlert(
  userId: number,
  data: {
    walletLabel: string;
    walletAddress: string;
    tokenSymbol: string;
    tokenMint: string;
    type: "buy" | "sell";
    amount: number;
    solAmount?: number;
    priceUsd?: number;
  }
): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.telegramChatId) return false;

  const emoji = data.type === "buy" ? "🟢" : "🔴";
  const action = data.type === "buy" ? "bought" : "sold";
  const priceInfo = data.priceUsd ? ` @ $${data.priceUsd.toFixed(6)}` : "";
  const solInfo = data.solAmount ? ` (${data.solAmount.toFixed(3)} SOL)` : "";

  const message = `${emoji} *Swap Detected*\n\n*${data.walletLabel || "Wallet"}* ${action} *${data.tokenSymbol}*${priceInfo}${solInfo}\n\n\`${data.walletAddress.slice(0, 8)}...${data.walletAddress.slice(-4)}\`\nToken: \`${data.tokenMint.slice(0, 8)}...\``;

  await log("telegram", "send_swap_alert", "info", { userId, context: { tokenSymbol: data.tokenSymbol, type: data.type } });
  return await sendMessage(user.telegramChatId, message);
}

export async function sendWhaleAlert(
  userId: number,
  data: {
    tokenSymbol: string;
    tokenMint: string;
    whaleAddress: string;
    tier: "top10" | "top50" | "top100";
    action: "buy" | "sell";
    amount: number;
    isEmergingWhale?: boolean;
  }
): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.telegramChatId) return false;

  const tierEmoji = data.tier === "top10" ? "🐋" : data.tier === "top50" ? "🐬" : "🐟";
  const actionEmoji = data.action === "buy" ? "🟢" : "🔴";
  const emergingTag = data.isEmergingWhale ? " *(NEW TOP HOLDER)*" : "";

  const message = `${tierEmoji}${actionEmoji} *Whale ${data.action.toUpperCase()}*${emergingTag}\n\n*${data.tokenSymbol}* - ${data.tier.replace("top", "Top ")} holder\nAmount: ${data.amount.toLocaleString()}\n\n\`${data.whaleAddress.slice(0, 8)}...${data.whaleAddress.slice(-4)}\``;

  await log("telegram", "send_whale_alert", "info", { userId, context: { tokenSymbol: data.tokenSymbol, tier: data.tier } });
  return await sendMessage(user.telegramChatId, message);
}

export async function sendPincherInsight(userId: number, insight: string): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.telegramChatId) return false;

  const message = `🦀 *Miss Pincher says:*\n\n${insight}`;
  await log("telegram", "send_insight", "info", { userId });
  return await sendMessage(user.telegramChatId, message);
}

export async function sendToAllLinkedUsers(message: string): Promise<number> {
  const linkedUsers = await db
    .select()
    .from(users)
    .where(sql`${users.telegramChatId} IS NOT NULL`);

  let sent = 0;
  for (const user of linkedUsers) {
    if (user.telegramChatId) {
      const success = await sendMessage(user.telegramChatId, message);
      if (success) sent++;
    }
  }

  await log("telegram", "broadcast", "success", { context: { sent, total: linkedUsers.length } });
  return sent;
}

export async function sendToAdmins(message: string): Promise<number> {
  const admins = await db
    .select()
    .from(users)
    .where(and(eq(users.isAdmin, true), sql`${users.telegramChatId} IS NOT NULL`));

  let sent = 0;
  for (const admin of admins) {
    if (admin.telegramChatId) {
      const success = await sendMessage(admin.telegramChatId, message);
      if (success) sent++;
    }
  }

  await log("telegram", "admin_broadcast", "success", { context: { sent } });
  return sent;
}
