/**
 * Debug utility: Compare Pincher2 internal state against external data sources
 * - Pincher2 DB: tokenDataPool, rawTokenTrades
 * - External: RPC (Solana blockchain state), DexScreener, Shyft
 */

import { db } from '../server/db.js';
import { tokenDataPool, rawTokenTrades } from '../shared/schema.js';
import { sql } from 'drizzle-orm';

/**
 * Get recent token launches from Pincher2 DB
 */
async function getRecentTokensFromDB(hoursBack: number = 24) {
  const timeThreshold = Math.floor(Date.now() / 1000) - (hoursBack * 3600);

  const tokens = await db
    .select({
      tokenMint: tokenDataPool.tokenMint,
      createdAt: tokenDataPool.createdAt,
      name: tokenDataPool.name,
      tradeCount: sql`COUNT(${rawTokenTrades.id}) as tradeCount`,
    })
    .from(tokenDataPool)
    .leftJoin(rawTokenTrades, sql`${tokenDataPool.tokenMint} = ${rawTokenTrades.tokenMint}`)
    .where(sql`${tokenDataPool.createdAt} > ${timeThreshold}`)
    .groupBy(tokenDataPool.tokenMint, tokenDataPool.createdAt, tokenDataPool.name)
    .orderBy(sql`${tokenDataPool.createdAt} DESC`)
    .limit(100);

  return tokens;
}

/**
 * Try to fetch token listing from DexScreener
 */
async function getRecentTokensFromDexScreener(hoursBack: number = 24) {
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/solana?order=createdAt&limit=50',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://dexscreener.com/',
        },
      }
    );

    if (!res.ok) {
      return { error: `HTTP ${res.status}`, source: 'DexScreener' };
    }

    const data = (await res.json()) as any;
    return {
      tokens: data.tokens || data.pairs || [],
      source: 'DexScreener',
    };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      source: 'DexScreener',
    };
  }
}

/**
 * Main comparison
 */
async function compareDataSources() {
  console.log('=== Pincher2 Data Validation ===\n');
  console.log(
    `Comparing token data from multiple sources (last 24 hours)\n`
  );

  // Get Pincher2 DB tokens
  console.log('[1] Querying Pincher2 database...');
  const dbTokens = await getRecentTokensFromDB(24);
  console.log(`Found ${dbTokens.length} tokens in Pincher2 DB\n`);

  if (dbTokens.length === 0) {
    console.log('No tokens found in Pincher2 DB from last 24 hours.');
    console.log('System may be in cold-start phase.\n');
  } else {
    console.log('Sample tokens from Pincher2 DB:');
    dbTokens.slice(0, 5).forEach((token, i) => {
      const age = Math.round(
        (Date.now() / 1000 - (token.createdAt || 0)) / 60
      );
      console.log(
        `  ${i + 1}. ${token.name || 'unnamed'} (${token.tokenMint.substring(0, 8)}...) - ${age}min ago - ${token.tradeCount || 0} trades`
      );
    });
    console.log();
  }

  // Try DexScreener
  console.log('[2] Querying DexScreener (recent Solana tokens)...');
  const dexscreenerResult = await getRecentTokensFromDexScreener(24);

  if ('error' in dexscreenerResult) {
    console.log(`✗ Error: ${dexscreenerResult.error}\n`);
  } else {
    const tokens = dexscreenerResult.tokens;
    console.log(`Found ${tokens.length} tokens from DexScreener\n`);

    if (tokens.length > 0) {
      console.log('Sample tokens from DexScreener:');
      tokens.slice(0, 5).forEach((token: any, i: number) => {
        const age = token.createdAt
          ? Math.round((Date.now() / 1000 - parseInt(token.createdAt)) / 60)
          : '?';
        console.log(
          `  ${i + 1}. ${token.name || token.symbol || 'unnamed'} (${
            token.address || token.mint
          }) - ${age}min ago`
        );
      });
      console.log();
    }
  }

  // Comparison
  console.log('[3] Cross-reference comparison:');
  if (dbTokens.length > 0 && !('error' in dexscreenerResult)) {
    const dbMints = new Set(
      dbTokens.map((t) => t.tokenMint.toLowerCase())
    );
    const dsMints = new Set(
      dexscreenerResult.tokens.map(
        (t: any) => (t.mint || t.address || '').toLowerCase()
      )
    );

    const overlap = Array.from(dbMints).filter((m) =>
      dsMints.has(m)
    );
    const dbOnly = Array.from(dbMints).filter((m) =>
      !dsMints.has(m)
    );
    const dsOnly = Array.from(dsMints).filter((m) =>
      !dbMints.has(m)
    );

    console.log(
      `  ✓ Tokens in both: ${overlap.length}`
    );
    console.log(
      `  ✓ Pincher2 only: ${dbOnly.length}`
    );
    console.log(
      `  ✓ DexScreener only: ${dsOnly.length}`
    );

    if (dbOnly.length > 0) {
      console.log(`\n  Pincher2 found tokens DexScreener missed:`);
      dbOnly.slice(0, 3).forEach((mint) => {
        const token = dbTokens.find(
          (t) => t.tokenMint.toLowerCase() === mint
        );
        console.log(
          `    - ${token?.name || 'unnamed'} (${mint.substring(0, 8)}...)`
        );
      });
    }

    if (dsOnly.length > 0) {
      console.log(`\n  DexScreener found tokens Pincher2 missed:`);
      dsOnly.slice(0, 3).forEach((mint) => {
        const token = dexscreenerResult.tokens.find(
          (t: any) =>
            (t.mint || t.address || '').toLowerCase() === mint
        );
        console.log(
          `    - ${token?.name || token?.symbol || 'unnamed'} (${mint.substring(0, 8)}...)`
        );
      });
    }
  }

  console.log('\n=== Summary ===');
  console.log('✓ Pincher2 DB querying works');
  console.log(
    dexscreenerResult && 'error' in dexscreenerResult
      ? `✗ External API access blocked: ${dexscreenerResult.error}`
      : '✓ DexScreener API accessible'
  );
  console.log(
    '\nFor full Solscan/Pump.fun scraping, use: npm run debug:scrape-pump'
  );
}

compareDataSources().catch(console.error);
