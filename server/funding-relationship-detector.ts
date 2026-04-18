import { db } from "./db";
import { eq, and, gte, lte, inArray, desc, asc } from "drizzle-orm";
import { swaps, walletFundingLinks, monitoredWallets } from "@shared/schema";
import { getTopFamiliarWhales } from "./familiar-whales";
import { checkApiQuota } from "./api-budget-enforcer";

// Constants
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_FUNDING_SOL = 0.1; // Ignore dust transfers
const RECIPIENT_CLASSIFICATION_WINDOW = 48 * 3600; // 48 hours to classify
const DORMANT_THRESHOLD = 7 * 24 * 3600; // 7 days before discard
const MAX_FRESH_WALLET_TRANSACTIONS = 5;
const MIN_FUNDER_SUCCESS_RATE = 0.60;

interface FreshWallet {
  address: string;
  transactionCount: number;
}

/**
 * Detect new SOL transfers from top wallets to fresh addresses
 * Primary: query local swaps table
 * Fallback: (future) query RPC for recent transactions if needed
 */
export async function detectFundingTransfers(): Promise<typeof walletFundingLinks.$inferInsert[]> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;

  // Get top familiar whales (high success rate)
  const topWallets = await getTopFamiliarWhales(MIN_FUNDER_SUCCESS_RATE);
  const topWalletAddresses = topWallets.map((w) => w.address);

  if (topWalletAddresses.length === 0) {
    console.log("[FundingDetector] No top wallets found");
    return [];
  }

  // Query local swaps table for SOL transfers from top wallets in past 7 days
  // SOL transfers appear as either:
  // - fromToken = SOL_MINT (swapping SOL for something)
  // - toToken = SOL_MINT (receiving SOL)
  // We want transfers where the funder sends SOL out
  const solTransfers = await db
    .select()
    .from(swaps)
    .where(
      and(
        inArray(swaps.source, topWalletAddresses),
        eq(swaps.fromToken, SOL_MINT), // Sending SOL
        gte(swaps.timestamp, sevenDaysAgo),
        gte(swaps.amount, MIN_FUNDING_SOL)
      )
    )
    .orderBy(desc(swaps.timestamp));

  console.log(`[FundingDetector] Found ${solTransfers.length} SOL transfers from top wallets`);

  // Identify recipients who are "fresh" (minimal transaction history)
  const recipientAddresses = [...new Set(solTransfers.map((t) => t.destination))];
  const freshRecipients = await filterFreshWallets(recipientAddresses);

  console.log(`[FundingDetector] Identified ${freshRecipients.size} fresh recipient wallets`);

  // Create funding link entries
  const newLinks: (typeof walletFundingLinks.$inferInsert)[] = [];

  for (const transfer of solTransfers) {
    // Only link to fresh wallets
    if (!freshRecipients.has(transfer.destination)) {
      continue;
    }

    // Check if this link already exists
    const existing = await db
      .select()
      .from(walletFundingLinks)
      .where(
        and(
          eq(walletFundingLinks.funderWallet, transfer.source),
          eq(walletFundingLinks.recipientWallet, transfer.destination),
          eq(walletFundingLinks.transferredAt, transfer.timestamp)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      // Get funder's success rate at time of funding
      const funder = topWallets.find((w) => w.address === transfer.source);
      const successRate = funder?.successRate || 0.6;

      newLinks.push({
        funderWallet: transfer.source,
        recipientWallet: transfer.destination,
        solAmount: transfer.amount,
        transferredAt: transfer.timestamp,
        discoveredAt: now,
        recipientStatus: "pending",
        funderSuccessRate: successRate,
      });
    }
  }

  // Insert new links
  if (newLinks.length > 0) {
    await db.insert(walletFundingLinks).values(newLinks);
    console.log(`[FundingDetector] Created ${newLinks.length} new funding links`);
  }

  return newLinks;
}

/**
 * Filter wallet addresses to find "fresh" ones (minimal transaction history)
 */
async function filterFreshWallets(addresses: string[]): Promise<Set<string>> {
  const freshWallets = new Set<string>();

  // Query swaps table to count transactions per wallet
  // TODO: For deeper history (7+ days), switch to Chainstack RPC getSignaturesForAddress
  // and add quota check: await checkApiQuota("chainstack", 5); // 5 credits per RPC call
  for (const address of addresses) {
    // Check quota if using Chainstack RPC (future enhancement)
    try {
      // Uncomment when switching to RPC: await checkApiQuota("chainstack", 5);
    } catch (error) {
      console.error(`[FundingDetector] Quota exceeded for ${address}:`, error);
      continue;
    }

    const txCount = await db
      .select()
      .from(swaps)
      .where(eq(swaps.source, address));

    // Consider fresh if <5 transactions
    if (txCount.length < MAX_FRESH_WALLET_TRANSACTIONS) {
      freshWallets.add(address);
    }
  }

  return freshWallets;
}

/**
 * Classify pending recipients based on their first action
 * Actions: token_buy (position wallet), sweep (exchange deposit), sol_transfer (obfuscation)
 */
export async function classifyFundingRecipients(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Get pending links that are still in classification window
  const pending = await db
    .select()
    .from(walletFundingLinks)
    .where(
      and(
        eq(walletFundingLinks.recipientStatus, "pending"),
        gte(walletFundingLinks.discoveredAt, now - DORMANT_THRESHOLD) // Only recent ones
      )
    );

  console.log(`[FundingDetector] Classifying ${pending.length} pending funding links`);

  for (const link of pending) {
    const recipient = link.recipientWallet;
    const deadline = link.transferredAt + RECIPIENT_CLASSIFICATION_WINDOW;

    // Query for recipient's first action after funding
    const firstAction = await db
      .select()
      .from(swaps)
      .where(
        and(
          eq(swaps.source, recipient),
          gte(swaps.timestamp, link.transferredAt),
          lte(swaps.timestamp, deadline)
        )
      )
      .orderBy(asc(swaps.timestamp))
      .limit(1);

    if (firstAction.length > 0) {
      const action = firstAction[0];
      const actionType = classifyAction(action);

      if (actionType === "sweep") {
        // Recipient immediately moved SOL → likely exchange deposit
        await db
          .update(walletFundingLinks)
          .set({
            recipientStatus: "exchange_deposit",
            recipientFirstActionType: "sweep",
            updatedAt: now,
          })
          .where(eq(walletFundingLinks.id, link.id));

        console.log(
          `[FundingDetector] Link ${link.id}: recipient is exchange deposit (sweep detected)`
        );
      } else if (actionType === "token_buy") {
        // Real position wallet - verify and mark as verified
        await db
          .update(walletFundingLinks)
          .set({
            recipientStatus: "position_wallet",
            recipientFirstActionType: "token_buy",
            recipientFirstActionAt: action.timestamp,
            isVerified: true,
            updatedAt: now,
          })
          .where(eq(walletFundingLinks.id, link.id));

        console.log(
          `[FundingDetector] Link ${link.id}: recipient is position wallet (token buy verified)`
        );
      } else if (actionType === "sol_transfer") {
        // Possible obfuscation - follow one hop
        const nextRecipient = action.destination;
        const isNextFresh = await isWalletFresh(nextRecipient);

        if (isNextFresh) {
          // Create link for next hop
          const chainLink: typeof walletFundingLinks.$inferInsert = {
            funderWallet: recipient, // Current recipient becomes next funder
            recipientWallet: nextRecipient,
            solAmount: action.amount,
            transferredAt: action.timestamp,
            discoveredAt: now,
            recipientStatus: "pending",
            chainDepth: 1,
            funderSuccessRate: link.funderSuccessRate, // Inherit success rate
          };

          await db.insert(walletFundingLinks).values(chainLink);

          // Mark original as obfuscation chain
          await db
            .update(walletFundingLinks)
            .set({
              recipientStatus: "obfuscation_chain",
              nextHopWallet: nextRecipient,
              recipientFirstActionType: "sol_transfer",
              updatedAt: now,
            })
            .where(eq(walletFundingLinks.id, link.id));

          console.log(
            `[FundingDetector] Link ${link.id}: obfuscation detected, following 1 hop to ${nextRecipient}`
          );
        } else {
          // Next recipient not fresh, mark as uncertain
          await db
            .update(walletFundingLinks)
            .set({
              recipientStatus: "pending", // Keep pending
              recipientFirstActionType: "sol_transfer",
              updatedAt: now,
            })
            .where(eq(walletFundingLinks.id, link.id));
        }
      }
    } else if (now - link.transferredAt > DORMANT_THRESHOLD) {
      // 7+ days with no action → discard
      await db.delete(walletFundingLinks).where(eq(walletFundingLinks.id, link.id));
      console.log(`[FundingDetector] Link ${link.id}: discarded (dormant >7 days)`);
    }
  }
}

/**
 * Classify a swap action as sweep, token_buy, or sol_transfer
 */
function classifyAction(
  swap: (typeof swaps.$inferSelect)
): "sweep" | "token_buy" | "sol_transfer" {
  // If swapping for SOL → likely sweep
  if (swap.toToken === SOL_MINT) {
    return "sweep";
  }

  // If swapping for a token → position wallet
  if (swap.fromToken === SOL_MINT && swap.toToken !== SOL_MINT) {
    return "token_buy";
  }

  // If transferring SOL → obfuscation chain
  if (swap.fromToken === SOL_MINT && swap.toToken === SOL_MINT) {
    return "sol_transfer";
  }

  // Default to token_buy
  return "token_buy";
}

/**
 * Check if a wallet is "fresh" (minimal transaction history)
 */
async function isWalletFresh(address: string): Promise<boolean> {
  const txCount = await db.select().from(swaps).where(eq(swaps.source, address));
  return txCount.length < MAX_FRESH_WALLET_TRANSACTIONS;
}

/**
 * Merge verified funding links into wallet clusters
 * (Will be called by cluster-detection.ts)
 */
export async function getVerifiedFundingLinks(): Promise<(typeof walletFundingLinks.$inferSelect)[]> {
  return db
    .select()
    .from(walletFundingLinks)
    .where(
      and(
        eq(walletFundingLinks.isVerified, true),
        eq(walletFundingLinks.recipientStatus, "position_wallet")
      )
    );
}

/**
 * Check if a wallet has a verified funding link and return funder info for signal inheritance
 */
export async function getInheritedSignalFromFundingLink(
  recipientWallet: string
): Promise<{
  funderWallet: string;
  funderSuccessRate: number;
  linkId: number;
} | null> {
  try {
    const link = await db
      .select()
      .from(walletFundingLinks)
      .where(
        and(
          eq(walletFundingLinks.recipientWallet, recipientWallet),
          eq(walletFundingLinks.isVerified, true),
          eq(walletFundingLinks.recipientStatus, "position_wallet")
        )
      )
      .limit(1);

    if (link.length === 0) {
      return null;
    }

    const fundingLink = link[0];
    return {
      funderWallet: fundingLink.funderWallet,
      funderSuccessRate: fundingLink.funderSuccessRate || 0.6,
      linkId: fundingLink.id,
    };
  } catch (error) {
    console.error(
      `[FundingDetector] Error checking inherited signal for ${recipientWallet}:`,
      error
    );
    return null;
  }
}

/**
 * Main daily job - detect and classify funding relationships
 */
export async function runFundingRelationshipDetection(): Promise<{
  newLinksDetected: number;
  classificationUpdates: number;
  verifiedLinksReady: number;
}> {
  console.log("[FundingDetector] Starting daily funding relationship detection");

  try {
    // Step 1: Detect new SOL transfers
    const newLinks = await detectFundingTransfers();

    // Step 2: Classify pending recipients
    await classifyFundingRecipients();

    // Step 3: Get verified links ready for clustering
    const verifiedLinks = await getVerifiedFundingLinks();

    console.log(
      `[FundingDetector] Complete: ${newLinks.length} new, ${verifiedLinks.length} verified`
    );

    return {
      newLinksDetected: newLinks.length,
      classificationUpdates: 0, // Not tracking individual updates
      verifiedLinksReady: verifiedLinks.length,
    };
  } catch (error) {
    console.error("[FundingDetector] Error during detection:", error);
    throw error;
  }
}
