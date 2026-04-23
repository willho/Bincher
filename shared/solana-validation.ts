/**
 * Solana address validation utilities
 * Based on learnings from api-test validation
 */

/**
 * Validate if string is a valid Solana mint address
 * - Exactly 43-44 characters (base58)
 * - Valid base58 characters: [1-9A-HJ-NP-Z]
 */
export function isValidSolanaAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  if (address.length < 43 || address.length > 44) return false;
  // Base58 alphabet (Solana standard)
  return /^[1-9A-HJ-NP-Z]+$/.test(address);
}

/**
 * Validate array of token mints
 * Filters out invalid addresses and logs count of discarded items
 */
export function filterValidSolanaAddresses(addresses: unknown[]): string[] {
  const valid: string[] = [];
  let invalid = 0;

  for (const addr of addresses) {
    if (isValidSolanaAddress(addr)) {
      valid.push(addr as string);
    } else {
      invalid++;
    }
  }

  if (invalid > 0) {
    console.warn(`[Validation] Filtered out ${invalid} invalid Solana addresses`);
  }

  return valid;
}

/**
 * Validate token mint before API operations
 * Throws error if invalid
 */
export function requireValidSolanaAddress(address: unknown, context: string): string {
  if (!isValidSolanaAddress(address)) {
    throw new Error(
      `Invalid Solana address in ${context}: "${String(address)}" ` +
      `(must be 43-44 base58 characters)`
    );
  }
  return address as string;
}
