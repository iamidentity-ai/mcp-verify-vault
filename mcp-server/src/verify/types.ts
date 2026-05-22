export interface RarEntry {
  type: string;
  operationDetails?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface TokenExchangeRequest {
  subjectToken: string;            // user's access_token from the UI
  scope: string;
  authorizationDetails: RarEntry[];
}

export interface TokenExchangeResult {
  obo: string;                     // access_token (real OBO post-MFA if VIP)
  expiresIn: number;
  scope: string;
  jti?: string;
  authorizationDetails: RarEntry[]; // Verify-attested RAR (re-evaluated post-MFA)
  vipPath: boolean;                 // whether the mfa_challenge leg fired
}

/**
 * Result of polling an IBM Verify MFA transaction.
 * Mirrors healthcare/mcp-server/src/auth/token-exchange.ts:226-229.
 */
export type MfaPollResult =
  | { state: 'approved'; assertion: string }
  | { state: 'denied'; reason: string }
  | { state: 'timeout' };

/**
 * Thrown when the auto-driven MFA flow inside exchangeToken cannot succeed.
 * Callers can switch on .code to render a user-friendly message.
 *   mfa_no_factor: user has no userPresence push factor enrolled
 *   mfa_denied:    user tapped Deny (or the transaction was rejected)
 *   mfa_timeout:   user did not respond within MFA_POLL_TIMEOUT_MS
 *   mfa_challenge_no_token: Verify returned mfa_challenge with no access_token
 */
export class MfaError extends Error {
  constructor(
    public readonly code:
      | 'mfa_no_factor'
      | 'mfa_denied'
      | 'mfa_timeout'
      | 'mfa_challenge_no_token',
    message: string,
  ) {
    super(message);
    this.name = 'MfaError';
  }
}
