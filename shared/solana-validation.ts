/**
 * Solana address validation utilities
 * Based on learnings from api-test validation
 */

/**
 * Normalize Solana address before validation
 * - Trim whitespace
 * - Decode URL encoding
 * - Remove common prefixes
 */
export function normalizeSolanaAddress(address: unknown): string | null {
  if (typeof address !== 'string') return null;

  let normalized = address.trim();

  // Decode URL encoding (e.g., %20 -> space, but we already trimmed)
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // If decoding fails, continue with original
  }

  // Remove common prefixes
  if (normalized.startsWith('solana:')) normalized = normalized.slice(7);
  if (normalized.startsWith('0x')) normalized = normalized.slice(2);

  return normalized.trim() || null;
}

/**
 * Validate if string is a valid Solana mint address
 * - Exactly 43-44 characters (base58)
 * - Valid base58 characters: [1-9A-HJ-NP-Z]
 */
export function isValidSolanaAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;

  const normalized = normalizeSolanaAddress(address);
  if (!normalized) return false;

  if (normalized.length < 43 || normalized.length > 44) return false;
  // Base58 alphabet (Solana standard)
  return /^[1-9A-HJ-NP-Z]+$/.test(normalized);
}

/**
 * Validate and normalize array of token mints
 * Filters out invalid addresses and logs count of discarded items
 */
export function filterValidSolanaAddresses(addresses: unknown[]): string[] {
  const valid: string[] = [];
  const normalized: string[] = [];
  let invalid = 0;
  let normalizedCount = 0;

  for (const addr of addresses) {
    const norm = normalizeSolanaAddress(addr);
    if (norm && isValidSolanaAddress(norm)) {
      valid.push(norm);
      if (norm !== addr) {
        normalizedCount++;
        normalized.push(`"${String(addr)}" → "${norm}"`);
      }
    } else {
      invalid++;
    }
  }

  if (invalid > 0) {
    console.warn(`[Validation] Filtered out ${invalid} invalid Solana addresses`);
  }
  if (normalizedCount > 0) {
    console.info(`[Validation] Normalized ${normalizedCount} addresses (trimmed/decoded)`);
    if (normalizedCount <= 5) {
      normalized.forEach(n => console.debug(`  ${n}`));
    }
  }

  return valid;
}

/**
 * Validate and normalize token mint before API operations
 * Returns normalized address if valid, throws if invalid
 */
export function requireValidSolanaAddress(address: unknown, context: string): string {
  const normalized = normalizeSolanaAddress(address);

  if (!normalized || !isValidSolanaAddress(normalized)) {
    throw new Error(
      `Invalid Solana address in ${context}: "${String(address)}" ` +
      `(must be 43-44 base58 characters)`
    );
  }

  if (normalized !== address) {
    console.debug(`[Validation] Normalized address in ${context}: "${String(address)}" → "${normalized}"`);
  }

  return normalized;
}
