// Classifies failures the relayer sees so the caller can decide whether to retry,
// drop permanently, or back off / circuit-break. Kept narrow on purpose — anything
// not recognized falls through to TRANSIENT so we never silently drop a real message.

export enum FailureKind {
  TRANSIENT = 'transient',         // network blip, blockhash expired, RPC 5xx, rate limit — retry
  PERMANENT = 'permanent',         // bad recipient pubkey, malformed payload — do not retry
  ALREADY_PROCESSED = 'already',   // on-chain says nonce already consumed — treat as delivered
  INSUFFICIENT_FUNDS = 'no_funds', // relayer is broke — pause, don't burn retries
}

export interface Classified {
  kind: FailureKind;
  reason: string;
}

export function classify(err: any): Classified {
  const raw: string = (err?.message || String(err) || '').toLowerCase();
  const logs: string[] = (err?.logs || err?.transactionLogs || []).map((l: string) => String(l).toLowerCase());
  const all = raw + ' ' + logs.join(' ');

  // Already-processed: the Anchor program rejects a duplicate nonce, or the PDA
  // already exists ("account already in use"). Both mean the bridge state is
  // consistent with delivery — no further action needed.
  if (
    all.includes('already in use') ||
    all.includes('already processed') ||
    all.includes('alreadyprocessed') ||
    all.includes('custom program error: 0x0') && all.includes('processed')
  ) {
    return { kind: FailureKind.ALREADY_PROCESSED, reason: 'nonce already consumed on-chain' };
  }

  // Insufficient funds — either relayer SOL for fees, or the explicit precheck we throw.
  if (
    all.includes('insufficient') && (all.includes('lamports') || all.includes('balance') || all.includes('funds'))
  ) {
    return { kind: FailureKind.INSUFFICIENT_FUNDS, reason: 'relayer balance too low' };
  }

  // Permanent payload problems: bad base58, wrong length, invalid pubkey.
  if (
    all.includes('non-base58') ||
    all.includes('invalid public key') ||
    all.includes('invalid base58') ||
    all.includes('invalid length') ||
    all.includes('bad secret key size')
  ) {
    return { kind: FailureKind.PERMANENT, reason: 'malformed payload / invalid pubkey' };
  }

  // Anchor program reverts that are NOT "already processed" — these are validation
  // failures (paused, wrong relayer, wrong mint). Permanent until config changes.
  // We require an explicit anchor error code marker so we don't catch RPC errors here.
  if (all.includes('anchorerror') || (all.includes('error code:') && all.includes('error number:'))) {
    if (!all.includes('blockhashnotfound')) {
      return { kind: FailureKind.PERMANENT, reason: 'program rejected payload' };
    }
  }

  // Everything else: blockhash expired, 429, timeouts, ECONNRESET, websocket drop, etc.
  return { kind: FailureKind.TRANSIENT, reason: raw.slice(0, 200) };
}

// Exponential backoff with jitter. Cap is important — we don't want a "submitted"
// message to sleep for an hour and look stuck.
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const jitter = Math.random() * exp * 0.25; // up to 25% jitter
  return Math.floor(exp - exp * 0.125 + jitter); // center ±12.5%
}
