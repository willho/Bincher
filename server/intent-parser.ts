import { getHotWalletBalance, updateTradeConfig, getHoldings, getPendingBuys } from "./wallet";

export interface ParsedIntent {
  type: 'buy' | 'sell' | 'balance' | 'holdings' | 'pending' | 'enable_copy' | 'disable_copy' | 'set_config' | 'confirm' | 'cancel' | 'conversation';
  params?: Record<string, any>;
}

export interface IntentResult {
  handled: boolean;
  response?: string;
  shouldCallAI?: boolean;
}

const buyPatterns = [
  /^buy\s+(\d*\.?\d+)?\s*sol\s+(?:of\s+)?(\w+)/i,
  /^buy\s+(\w+)(?:\s+(\d*\.?\d+)\s*sol)?/i,
  /^get\s+(?:some\s+)?(\w+)/i,
];

const sellPatterns = [
  /^sell\s+(all|\d+%?)\s+(?:of\s+)?(?:my\s+)?(\w+)/i,
  /^sell\s+(\w+)/i,
  /^dump\s+(\w+)/i,
];

const balancePatterns = [
  /^balance$/i,
  /^check\s+balance/i,
  /^wallet\s+balance/i,
  /^how\s+much\s+sol/i,
];

const holdingsPatterns = [
  /^holdings$/i,
  /^show\s+holdings/i,
  /^my\s+holdings/i,
  /^what\s+do\s+i\s+have/i,
  /^portfolio/i,
];

const pendingPatterns = [
  /^pending$/i,
  /^show\s+pending/i,
  /^pending\s+orders?/i,
  /^queued/i,
];

const enableCopyPatterns = [
  /^enable\s+copy\s*(?:trading)?/i,
  /^turn\s+on\s+copy/i,
  /^start\s+copy/i,
];

const disableCopyPatterns = [
  /^disable\s+copy\s*(?:trading)?/i,
  /^turn\s+off\s+copy/i,
  /^stop\s+copy/i,
];

const confirmPatterns = [
  /^(yes|yep|yeah|yea|do\s+it|confirm|confirmed|go|go\s+ahead|execute|proceed|ok|okay|sure|send\s+it|let'?s\s+go|lfg)$/i,
];

const cancelPatterns = [
  /^(no|nope|cancel|nevermind|never\s+mind|wait|stop|don'?t)$/i,
];

export function parseIntent(message: string): ParsedIntent {
  const msg = message.trim();
  
  for (const pattern of confirmPatterns) {
    if (pattern.test(msg)) {
      return { type: 'confirm' };
    }
  }
  
  for (const pattern of cancelPatterns) {
    if (pattern.test(msg)) {
      return { type: 'cancel' };
    }
  }
  
  for (const pattern of balancePatterns) {
    if (pattern.test(msg)) {
      return { type: 'balance' };
    }
  }
  
  for (const pattern of holdingsPatterns) {
    if (pattern.test(msg)) {
      return { type: 'holdings' };
    }
  }
  
  for (const pattern of pendingPatterns) {
    if (pattern.test(msg)) {
      return { type: 'pending' };
    }
  }
  
  for (const pattern of enableCopyPatterns) {
    if (pattern.test(msg)) {
      return { type: 'enable_copy' };
    }
  }
  
  for (const pattern of disableCopyPatterns) {
    if (pattern.test(msg)) {
      return { type: 'disable_copy' };
    }
  }
  
  for (const pattern of buyPatterns) {
    const match = msg.match(pattern);
    if (match) {
      const token = match[2] || match[1];
      const amount = match[1] && !isNaN(parseFloat(match[1])) ? parseFloat(match[1]) : undefined;
      return { type: 'buy', params: { token, amount } };
    }
  }
  
  for (const pattern of sellPatterns) {
    const match = msg.match(pattern);
    if (match) {
      const amount = match[1];
      const token = match[2] || match[1];
      return { type: 'sell', params: { token, amount } };
    }
  }
  
  return { type: 'conversation' };
}

export async function executeIntent(userId: number, intent: ParsedIntent): Promise<IntentResult> {
  switch (intent.type) {
    case 'balance': {
      const balance = await getHotWalletBalance(userId);
      if (balance === null) {
        return { handled: true, response: "No hot wallet set up yet. Create one in the Trading page." };
      }
      return { handled: true, response: `Your hot wallet balance: ${balance.toFixed(4)} SOL` };
    }
    
    case 'holdings': {
      const holdings = await getHoldings(userId);
      if (!holdings || holdings.length === 0) {
        return { handled: true, response: "No active holdings yet. Start trading to see positions here." };
      }
      const activeHoldings = holdings.filter(h => !h.reclaimed && h.currentAmount > 0);
      if (activeHoldings.length === 0) {
        return { handled: true, response: "No active holdings. All positions have been closed." };
      }
      const summary = activeHoldings.map(h => {
        const pnl = h.lastPrice && h.buyPrice ? ((h.lastPrice / h.buyPrice - 1) * 100).toFixed(1) : '?';
        return `• ${h.tokenSymbol}: ${h.solSpent.toFixed(3)} SOL invested (${pnl}% PnL)`;
      }).join('\n');
      return { handled: true, response: `Your holdings:\n${summary}` };
    }
    
    case 'pending': {
      const pending = await getPendingBuys(userId);
      if (!pending || pending.length === 0) {
        return { handled: true, response: "No pending orders in queue." };
      }
      const activePending = pending.filter(p => p.status === 'active' || p.status === 'paused');
      if (activePending.length === 0) {
        return { handled: true, response: "No active pending orders." };
      }
      const summary = activePending.map(p => {
        const status = p.status === 'paused' ? ' (paused)' : '';
        return `• ${p.tokenSymbol}${status}`;
      }).join('\n');
      return { handled: true, response: `Pending orders:\n${summary}` };
    }
    
    case 'enable_copy': {
      await updateTradeConfig(userId, { enabled: true });
      return { handled: true, response: "Copy trading enabled. I'll mirror trades from your monitored wallets." };
    }
    
    case 'disable_copy': {
      await updateTradeConfig(userId, { enabled: false });
      return { handled: true, response: "Copy trading disabled. Monitoring continues but no automatic buys." };
    }
    
    case 'buy':
    case 'sell':
    case 'confirm':
    case 'cancel':
      return { handled: false, shouldCallAI: true };
    
    case 'conversation':
    default:
      return { handled: false, shouldCallAI: true };
  }
}

export async function handleMessage(userId: number, message: string): Promise<IntentResult> {
  const intent = parseIntent(message);
  
  if (intent.type === 'conversation') {
    return { handled: false, shouldCallAI: true };
  }
  
  return executeIntent(userId, intent);
}
