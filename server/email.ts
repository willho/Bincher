import { Resend } from "resend";
import type { Swap } from "@shared/schema";

const resend = new Resend(process.env.RESEND_API_KEY);

function formatNumber(num: number | undefined, decimals: number = 2): string {
  if (num === undefined || num === null) return "N/A";
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(decimals)}`;
}

function formatPrice(price: number | undefined): string {
  if (price === undefined || price === null) return "N/A";
  if (price < 0.0001) return `$${price.toExponential(2)}`;
  if (price < 1) return `$${price.toFixed(6)}`;
  return `$${price.toFixed(2)}`;
}

function formatPriceChange(change: number | undefined): string {
  if (change === undefined || change === null) return "";
  const sign = change >= 0 ? "+" : "";
  const color = change >= 0 ? "#10b981" : "#ef4444";
  return `<span style="color: ${color}; font-weight: 600;">${sign}${change.toFixed(2)}%</span>`;
}

export async function sendSwapNotification(swap: Swap, toEmails: string | string[]): Promise<boolean> {
  const emailList = Array.isArray(toEmails) ? toEmails : [toEmails];
  try {
    const formattedDate = new Date(swap.timestamp).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    const meta = swap.toTokenMetadata;
    const hasMetadata = meta && (meta.marketCap || meta.liquidity || meta.priceUsd);

    const tokenDataSection = hasMetadata ? `
      <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.1) 0%, rgba(16, 185, 129, 0.05) 100%); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <h3 style="color: #10b981; margin: 0 0 16px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Token Bought: ${meta.name || swap.toTokenSymbol}</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="color: #94a3b8; padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05);">Price</td>
            <td style="color: #f1f5f9; padding: 10px 0; text-align: right; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.05);">
              ${formatPrice(meta.priceUsd)} ${meta.priceChange24h !== undefined ? formatPriceChange(meta.priceChange24h) : ""}
            </td>
          </tr>
          <tr>
            <td style="color: #94a3b8; padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05);">Market Cap</td>
            <td style="color: #f1f5f9; padding: 10px 0; text-align: right; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.05);">${formatNumber(meta.marketCap)}</td>
          </tr>
          <tr>
            <td style="color: #94a3b8; padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05);">Liquidity</td>
            <td style="color: #f1f5f9; padding: 10px 0; text-align: right; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.05);">${formatNumber(meta.liquidity)}</td>
          </tr>
          <tr>
            <td style="color: #94a3b8; padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05);">FDV</td>
            <td style="color: #f1f5f9; padding: 10px 0; text-align: right; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.05);">${formatNumber(meta.fdv)}</td>
          </tr>
          <tr>
            <td style="color: #94a3b8; padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05);">24h Volume</td>
            <td style="color: #f1f5f9; padding: 10px 0; text-align: right; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.05);">${formatNumber(meta.volume24h)}</td>
          </tr>
          <tr>
            <td style="color: #94a3b8; padding: 10px 0; font-size: 13px;">DEX</td>
            <td style="color: #f1f5f9; padding: 10px 0; text-align: right; font-size: 14px; font-weight: 600; text-transform: capitalize;">${meta.dexId || "N/A"}</td>
          </tr>
        </table>
        ${meta.pairAddress ? `
          <div style="margin-top: 16px; text-align: center;">
            <a href="https://dexscreener.com/solana/${meta.pairAddress}" style="display: inline-block; background: rgba(16, 185, 129, 0.2); color: #10b981; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 600;">View on DexScreener</a>
          </div>
        ` : ""}
      </div>
    ` : "";

    const { data, error } = await resend.emails.send({
      from: "Swap Monitor <onboarding@resend.dev>",
      to: emailList,
      subject: `Swap Detected: ${swap.fromTokenSymbol} → ${swap.toTokenSymbol}`,
      html: `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 16px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #10b981; margin: 0; font-size: 28px; font-weight: 700;">Swap Detected</h1>
            <p style="color: #94a3b8; margin-top: 8px; font-size: 14px;">${formattedDate}</p>
          </div>
          
          <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="text-align: center; vertical-align: top; width: 45%;">
                  <p style="color: #94a3b8; margin: 0 0 4px 0; font-size: 12px; text-transform: uppercase;">Sold</p>
                  <p style="color: #f1f5f9; margin: 0; font-size: 24px; font-weight: 700;">${swap.fromAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                  <p style="color: #ef4444; margin: 4px 0 0 0; font-size: 16px; font-weight: 600;">${swap.fromTokenSymbol}</p>
                </td>
                <td style="text-align: center; vertical-align: middle; width: 10%;">
                  <span style="color: #10b981; font-size: 24px;">→</span>
                </td>
                <td style="text-align: center; vertical-align: top; width: 45%;">
                  <p style="color: #94a3b8; margin: 0 0 4px 0; font-size: 12px; text-transform: uppercase;">Bought</p>
                  <p style="color: #f1f5f9; margin: 0; font-size: 24px; font-weight: 700;">${swap.toAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                  <p style="color: #10b981; margin: 4px 0 0 0; font-size: 16px; font-weight: 600;">${swap.toTokenSymbol}</p>
                </td>
              </tr>
            </table>
          </div>

          ${tokenDataSection}
          
          <div style="background: rgba(255,255,255,0.03); border-radius: 8px; padding: 16px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="color: #64748b; padding: 8px 0; font-size: 13px;">Platform</td>
                <td style="color: #e2e8f0; padding: 8px 0; text-align: right; font-size: 13px;">${swap.source}</td>
              </tr>
              <tr>
                <td style="color: #64748b; padding: 8px 0; font-size: 13px;">Signature</td>
                <td style="color: #e2e8f0; padding: 8px 0; text-align: right; font-size: 12px; font-family: monospace;">
                  <a href="https://solscan.io/tx/${swap.signature}" style="color: #10b981; text-decoration: none;">${swap.signature.slice(0, 20)}...</a>
                </td>
              </tr>
              <tr>
                <td style="color: #64748b; padding: 8px 0; font-size: 13px;">Token Address</td>
                <td style="color: #e2e8f0; padding: 8px 0; text-align: right; font-size: 12px; font-family: monospace;">
                  <a href="https://solscan.io/token/${swap.toToken}" style="color: #10b981; text-decoration: none;">${swap.toToken.slice(0, 8)}...${swap.toToken.slice(-6)}</a>
                </td>
              </tr>
            </table>
          </div>
          
          <p style="color: #64748b; font-size: 12px; text-align: center; margin-top: 24px;">
            Wallet: C92nBXrrANmWpgJKhBdbnqtUuCcoEZ7kQJoyScZ5sQak
          </p>
        </div>
      `,
    });

    if (error) {
      console.error("Failed to send email:", error);
      return false;
    }

    console.log("Email sent successfully:", data?.id);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
}
