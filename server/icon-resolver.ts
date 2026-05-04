import { db } from "./db";
import { tokenDataPool } from "@shared/schema";
import { eq, isNull, and, lt, sql } from "drizzle-orm";
import { shouldAllowApiCall, trackApiCall } from "./api-budget";
import { getTokenData, upsertTokenData } from "./data-pool";
import { createComputeTask } from "./compute-manager";
import { REQUEST_PRIORITY } from "./budget-manager";

const PREFIX = "[IconResolver]";

const jupiterCache: Map<string, string> = new Map();
let jupiterCacheLoadedAt = 0;
const JUPITER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ICON_REFRESH_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

async function loadJupiterTokenList(): Promise<boolean> {
  const now = Date.now();
  if (jupiterCache.size > 0 && (now - jupiterCacheLoadedAt) < JUPITER_CACHE_TTL_MS) {
    return true;
  }

  const budgetCheck = await shouldAllowApiCall("jupiter");
  if (!budgetCheck.allowed) {
    console.log(`${PREFIX} Jupiter API budget exceeded, skipping list refresh`);
    return jupiterCache.size > 0;
  }

  try {
    const response = await fetch("https://token.jup.ag/all");
    await trackApiCall("jupiter", "tokenList", 1);

    if (!response.ok) {
      console.error(`${PREFIX} Jupiter token list fetch failed: ${response.status}`);
      return jupiterCache.size > 0;
    }

    const tokens: Array<{ address: string; logoURI?: string }> = await response.json();
    jupiterCache.clear();

    let iconCount = 0;
    for (const token of tokens) {
      if (token.logoURI && token.address) {
        jupiterCache.set(token.address, token.logoURI);
        iconCount++;
      }
    }

    jupiterCacheLoadedAt = now;
    console.log(`${PREFIX} Jupiter token list loaded: ${iconCount} icons from ${tokens.length} tokens`);
    return true;
  } catch (error) {
    console.error(`${PREFIX} Jupiter token list fetch error:`, error);
    return jupiterCache.size > 0;
  }
}

export function getJupiterIcon(tokenMint: string): string | null {
  return jupiterCache.get(tokenMint) || null;
}

export async function resolveIconForToken(tokenMint: string, priority: 'ui' | 'discovery' | 'backfill' = 'backfill'): Promise<string | null> {
  const poolData = await getTokenData(tokenMint);
  const now = Math.floor(Date.now() / 1000);

  if (poolData?.imageUrl) {
    const age = now - (poolData.imageUrlFetchedAt || 0);
    if (age < ICON_REFRESH_THRESHOLD_SECONDS) {
      return poolData.imageUrl;
    }
  }

  const jupiterIcon = getJupiterIcon(tokenMint);
  if (jupiterIcon) {
    await upsertTokenData(tokenMint, { imageUrl: jupiterIcon }, 'jupiter');
    return jupiterIcon;
  }

  if (priority === 'ui') {
    await loadJupiterTokenList();
    const iconAfterLoad = getJupiterIcon(tokenMint);
    if (iconAfterLoad) {
      await upsertTokenData(tokenMint, { imageUrl: iconAfterLoad }, 'jupiter');
      return iconAfterLoad;
    }
  }

  return poolData?.imageUrl || null;
}

export async function queueIconLookup(tokenMint: string, priority: 'ui' | 'discovery' | 'backfill' = 'backfill'): Promise<void> {
  const poolData = await getTokenData(tokenMint);
  const now = Math.floor(Date.now() / 1000);

  if (poolData?.imageUrl) {
    const age = now - (poolData.imageUrlFetchedAt || 0);
    if (age < ICON_REFRESH_THRESHOLD_SECONDS) {
      return;
    }
  }

  const taskPriority = priority === 'ui' ? 75 : priority === 'discovery' ? 25 : 10;

  await createComputeTask('token_metadata', {
    tokenMint,
    subtype: 'icon_lookup',
    priority: priority,
  }, {
    priority: taskPriority,
    ttlSeconds: priority === 'ui' ? 10 : 30,
    isUserRelevant: priority === 'ui',
  });
}

export async function batchResolveIcons(limit: number = 50): Promise<number> {
  await loadJupiterTokenList();

  const tokensNeedingIcons = await db.select({
    tokenMint: tokenDataPool.tokenMint,
  })
  .from(tokenDataPool)
  .where(
    and(
      isNull(tokenDataPool.imageUrl),
      eq(tokenDataPool.isActive, true),
    )
  )
  .orderBy(sql`${tokenDataPool.accessCount} DESC NULLS LAST`)
  .limit(limit);

  if (tokensNeedingIcons.length === 0) {
    return 0;
  }

  let resolved = 0;

  for (const { tokenMint } of tokensNeedingIcons) {
    const jupiterIcon = getJupiterIcon(tokenMint);
    if (jupiterIcon) {
      await upsertTokenData(tokenMint, { imageUrl: jupiterIcon }, 'jupiter');
      resolved++;
    }
  }

  if (resolved > 0) {
    console.log(`${PREFIX} Batch resolved ${resolved}/${tokensNeedingIcons.length} icons from Jupiter cache`);
  }

  return resolved;
}

let iconSchedulerRunning = false;
let iconSchedulerInterval: ReturnType<typeof setInterval> | null = null;

export function startIconScheduler(): void {
  if (iconSchedulerRunning) return;
  iconSchedulerRunning = true;

  loadJupiterTokenList().then(() => {
    batchResolveIcons(100).catch(e => console.error(`${PREFIX} Initial batch error:`, e));
  }).catch(e => console.error(`${PREFIX} Initial Jupiter load error:`, e));

  iconSchedulerInterval = setInterval(async () => {
    try {
      await batchResolveIcons(50);
    } catch (error) {
      console.error(`${PREFIX} Scheduler batch error:`, error);
    }
  }, 30 * 60 * 1000);

  console.log(`${PREFIX} Icon scheduler started (batch every 30min)`);
}

export function stopIconScheduler(): void {
  if (iconSchedulerInterval) {
    clearInterval(iconSchedulerInterval);
    iconSchedulerInterval = null;
  }
  iconSchedulerRunning = false;
  console.log(`${PREFIX} Icon scheduler stopped`);
}
