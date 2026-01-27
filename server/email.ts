import { Resend } from "resend";
import type { Swap } from "@shared/schema";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendSwapNotification(swap: Swap, toEmail: string): Promise<boolean> {
  try {
    const formattedDate = new Date(swap.timestamp).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });

    const { data, error } = await resend.emails.send({
      from: "Swap Monitor <onboarding@resend.dev>",
      to: [toEmail],
      subject: `Swap Detected: ${swap.fromTokenSymbol} → ${swap.toTokenSymbol}`,
      html: `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); border-radius: 16px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #10b981; margin: 0; font-size: 28px; font-weight: 700;">Swap Detected</h1>
            <p style="color: #94a3b8; margin-top: 8px; font-size: 14px;">${formattedDate}</p>
          </div>
          
          <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
              <div style="text-align: center; flex: 1;">
                <p style="color: #94a3b8; margin: 0 0 4px 0; font-size: 12px; text-transform: uppercase;">From</p>
                <p style="color: #f1f5f9; margin: 0; font-size: 24px; font-weight: 700;">${swap.fromAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                <p style="color: #10b981; margin: 4px 0 0 0; font-size: 16px; font-weight: 600;">${swap.fromTokenSymbol}</p>
              </div>
              <div style="color: #10b981; font-size: 24px; padding: 0 16px;">→</div>
              <div style="text-align: center; flex: 1;">
                <p style="color: #94a3b8; margin: 0 0 4px 0; font-size: 12px; text-transform: uppercase;">To</p>
                <p style="color: #f1f5f9; margin: 0; font-size: 24px; font-weight: 700;">${swap.toAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                <p style="color: #10b981; margin: 4px 0 0 0; font-size: 16px; font-weight: 600;">${swap.toTokenSymbol}</p>
              </div>
            </div>
          </div>
          
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
