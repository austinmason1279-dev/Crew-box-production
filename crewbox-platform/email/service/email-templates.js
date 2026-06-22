// ============================================================
// CREWBOX — EMAIL TEMPLATES
// File: email/service/email-templates.js
//
// All 8 HTML email templates.
// Design principles:
//   - Single column, max 600px — works in every email client
//   - Inline CSS only — Gmail strips <style> blocks
//   - White-label aware — brandName + primaryColor are injected
//   - Mobile-first — most contractors read on iPhone
//   - Plain, direct copy — trades audience, not tech audience
// ============================================================

// ── SHARED BASE STYLES ────────────────────────────────────
const BASE = {
  body:    'margin:0;padding:0;background:#F3F2F0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
  wrap:    'max-width:600px;margin:0 auto;background:#FFFFFF;',
  header:  (color) => `background:${color};padding:28px 32px;`,
  logo:    'font-size:22px;font-weight:900;color:#FFFFFF;letter-spacing:1px;text-decoration:none;',
  body_p:  'padding:28px 32px;',
  h1:      'font-size:24px;font-weight:700;color:#1A1A1A;margin:0 0 8px;line-height:1.3;',
  p:       'font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 16px;',
  p_sm:    'font-size:13px;color:#6B7280;line-height:1.5;margin:0 0 8px;',
  btn:     (color) => `display:inline-block;background:${color};color:#FFFFFF;font-size:16px;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:8px;`,
  divider: 'border:none;border-top:1px solid #E5E7EB;margin:20px 0;',
  footer:  'padding:20px 32px;background:#F9FAFB;border-top:1px solid #E5E7EB;text-align:center;',
  foot_p:  'font-size:12px;color:#9CA3AF;margin:0 0 4px;',
  amount:  'font-size:36px;font-weight:900;color:#1A1A1A;letter-spacing:-0.5px;',
};

// ── LINE ITEMS HTML ───────────────────────────────────────
function lineItemsHtml(items = []) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;">
      <tr style="background:#F9FAFB;">
        <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">Description</td>
        <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;text-align:right;">Amount</td>
      </tr>
      ${items.map(item => `
        <tr>
          <td style="padding:10px 12px;font-size:14px;color:#374151;border-bottom:1px solid #F3F4F6;">
            ${escHtml(item.description)}
            ${item.qty > 1 ? `<div style="font-size:12px;color:#9CA3AF;margin-top:2px">${item.qty} × $${Number(item.unitPrice || item.unit_price || 0).toFixed(2)}</div>` : ''}
          </td>
          <td style="padding:10px 12px;font-size:14px;color:#1A1A1A;font-weight:500;border-bottom:1px solid #F3F4F6;text-align:right;">$${Number(item.total).toFixed(2)}</td>
        </tr>`).join('')}
    </table>`;
}

function totalsHtml(subtotal, taxAmount, total) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${Number(taxAmount) > 0 ? `
        <tr>
          <td style="padding:6px 12px;font-size:13px;color:#6B7280;text-align:right;">Subtotal</td>
          <td style="padding:6px 12px;font-size:13px;color:#374151;text-align:right;width:80px;">$${Number(subtotal).toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;font-size:13px;color:#6B7280;text-align:right;">Tax</td>
          <td style="padding:6px 12px;font-size:13px;color:#374151;text-align:right;">$${Number(taxAmount).toFixed(2)}</td>
        </tr>` : ''}
      <tr style="border-top:2px solid #E5E7EB;">
        <td style="padding:10px 12px;font-size:16px;font-weight:700;color:#1A1A1A;text-align:right;">Total</td>
        <td style="padding:10px 12px;font-size:16px;font-weight:700;color:#1A1A1A;text-align:right;">$${Number(total).toFixed(2)}</td>
      </tr>
    </table>`;
}

function emailShell(content, footer, primaryColor = '#F5C800', brandName = 'CrewBox') {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${brandName}</title></head>
<body style="${BASE.body}">
<div style="${BASE.wrap}">
  <!-- Header -->
  <div style="${BASE.header(primaryColor)}">
    <span style="${BASE.logo}">${escHtml(brandName)}</span>
  </div>
  <!-- Body -->
  ${content}
  <!-- Footer -->
  <div style="${BASE.footer}">
    ${footer}
    <p style="${BASE.foot_p}">© ${new Date().getFullYear()} ${escHtml(brandName)}. All rights reserved.</p>
    <p style="${BASE.foot_p}">This email was sent regarding your account. <a href="#" style="color:#9CA3AF;">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;
}

// ============================================================
// 1. CONTRACTOR WELCOME
// ============================================================

export function contractorWelcomeTemplate({
  ownerName, businessName, trade, aiPhone,
  setupUrl, dashUrl, brandName, primaryColor,
}) {
  const content = `
    <div style="${BASE.body_p}">
      <h1 style="${BASE.h1}">Welcome to ${escHtml(brandName)}, ${escHtml(ownerName.split(' ')[0])}.</h1>
      <p style="${BASE.p}">Your AI crew is set up and ready to go to work for <strong>${escHtml(businessName)}</strong>. Here's what happens next:</p>

      <div style="background:#F9FAFB;border-radius:10px;padding:20px;margin:20px 0;">
        <div style="display:flex;margin-bottom:14px;">
          <div style="width:32px;height:32px;background:${primaryColor};border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#111;flex-shrink:0;text-align:center;line-height:32px;">1</div>
          <div style="margin-left:14px;">
            <div style="font-size:14px;font-weight:600;color:#1A1A1A;margin-bottom:2px;">Complete your setup (3 minutes)</div>
            <div style="font-size:13px;color:#6B7280;">Add your bank account, upload your license, and connect your phone.</div>
          </div>
        </div>
        <div style="display:flex;margin-bottom:14px;">
          <div style="width:32px;height:32px;background:${primaryColor};border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#111;flex-shrink:0;text-align:center;line-height:32px;">2</div>
          <div style="margin-left:14px;">
            <div style="font-size:14px;font-weight:600;color:#1A1A1A;margin-bottom:2px;">Forward your calls</div>
            <div style="font-size:13px;color:#6B7280;">One call to your carrier sends unanswered calls to your AI. Your existing number stays the same.</div>
          </div>
        </div>
        <div style="display:flex;">
          <div style="width:32px;height:32px;background:#22C55E;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;text-align:center;line-height:32px;">✓</div>
          <div style="margin-left:14px;">
            <div style="font-size:14px;font-weight:600;color:#1A1A1A;margin-bottom:2px;">Go do the work</div>
            <div style="font-size:13px;color:#6B7280;">Your AI crew handles calls, quotes, invoices, reviews, and social posts. You just show up.</div>
          </div>
        </div>
      </div>

      ${aiPhone ? `
        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:14px 16px;margin:16px 0;">
          <div style="font-size:12px;font-weight:600;color:#92400E;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Your AI phone number</div>
          <div style="font-size:22px;font-weight:900;color:#1A1A1A;font-family:monospace;">${escHtml(aiPhone)}</div>
          <div style="font-size:12px;color:#92400E;margin-top:4px;">Forward unanswered calls to this number from your existing line.</div>
        </div>` : ''}

      <div style="text-align:center;margin:24px 0;">
        <a href="${escHtml(setupUrl)}" style="${BASE.btn(primaryColor)}">Complete My Setup →</a>
      </div>
      <p style="font-size:13px;color:#9CA3AF;text-align:center;">Or go straight to your <a href="${escHtml(dashUrl)}" style="color:${primaryColor};">dashboard</a>.</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">Questions? Reply to this email or contact your ${escHtml(brandName)} representative.</p>`,
    primaryColor, brandName);
}

// ============================================================
// 2. INVOICE DELIVERY
// ============================================================

export function invoiceDeliveryTemplate({
  customerName, businessName, invoiceNumber, invoiceTitle,
  lineItems, subtotal, taxAmount, total, dueDate,
  paymentUrl, brandName, primaryColor, businessPhone,
}) {
  const formattedDue = dueDate ? new Date(dueDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '30 days';

  const content = `
    <div style="${BASE.body_p}">
      <p style="font-size:13px;color:#6B7280;margin:0 0 4px;">Invoice for ${escHtml(customerName)}</p>
      <h1 style="${BASE.h1}">${escHtml(invoiceTitle || 'Invoice from ' + businessName)}</h1>
      <p style="${BASE.p}">Hi ${escHtml(customerName.split(' ')[0])}, here's your invoice from <strong>${escHtml(businessName)}</strong>.</p>

      <div style="background:#F9FAFB;border-radius:10px;padding:20px 24px;margin:16px 0;text-align:center;">
        <div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Amount Due</div>
        <div style="${BASE.amount}">$${Number(total).toFixed(2)}</div>
        <div style="font-size:13px;color:#6B7280;margin-top:6px;">Due by ${formattedDue}</div>
        <div style="font-family:monospace;font-size:12px;color:#9CA3AF;margin-top:4px;">${escHtml(invoiceNumber)}</div>
      </div>

      ${lineItemsHtml(lineItems)}
      ${totalsHtml(subtotal, taxAmount, total)}

      <div style="text-align:center;margin:28px 0 8px;">
        <a href="${escHtml(paymentUrl)}" style="${BASE.btn(primaryColor)}">Pay Now — $${Number(total).toFixed(2)} →</a>
      </div>
      <p style="font-size:12px;color:#9CA3AF;text-align:center;margin-top:8px;">
        Pay securely by card, bank transfer, or Apple Pay. Powered by Stripe.
      </p>

      <hr style="${BASE.divider}"/>
      <p style="${BASE.p_sm}">Questions about this invoice? Contact <strong>${escHtml(businessName)}</strong>${businessPhone ? ` at ${escHtml(businessPhone)}` : ''}.</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">Invoice ${escHtml(invoiceNumber)} · ${escHtml(businessName)}</p>`,
    primaryColor, brandName);
}

// ============================================================
// 3. INVOICE REMINDER
// ============================================================

export function invoiceReminderTemplate({
  customerName, businessName, businessPhone, invoiceNumber,
  amountDue, daysOverdue, reminderNumber, tone,
  paymentUrl, brandName, primaryColor,
}) {
  const toneConfig = {
    friendly: {
      subject: 'Just a friendly reminder',
      color:   '#F59E0B',
      icon:    '👋',
      opening: `Hi ${escHtml(customerName.split(' ')[0])}, hope everything's going well. Just a quick reminder that invoice ${escHtml(invoiceNumber)} from ${escHtml(businessName)} is ${daysOverdue} day${daysOverdue !== 1 ? 's' : ''} past due.`,
      closing: 'If you have any questions or need to discuss payment options, please reach out.',
    },
    firm: {
      subject: 'Invoice payment required',
      color:   '#F97316',
      icon:    '📋',
      opening: `Hi ${escHtml(customerName.split(' ')[0])}, invoice ${escHtml(invoiceNumber)} from ${escHtml(businessName)} is now ${daysOverdue} days past due. Please take a moment to complete your payment.`,
      closing: `Please pay within the next 7 days. Contact us at ${escHtml(businessPhone || businessName)} if you have any issues.`,
    },
    final: {
      subject: 'Final notice — immediate payment required',
      color:   '#EF4444',
      icon:    '⚠️',
      opening: `Hi ${escHtml(customerName.split(' ')[0])}, this is a final notice regarding invoice ${escHtml(invoiceNumber)} from ${escHtml(businessName)}, which is now ${daysOverdue} days past due. Immediate payment is required.`,
      closing: 'If payment is not received, further steps may be taken. Please contact us to resolve this immediately.',
    },
  };

  const cfg = toneConfig[tone] || toneConfig.friendly;

  const content = `
    <div style="${BASE.body_p}">
      <div style="text-align:center;font-size:36px;margin-bottom:12px;">${cfg.icon}</div>
      <h1 style="${BASE.h1};text-align:center;">Payment Reminder</h1>
      <p style="${BASE.p}">${cfg.opening}</p>

      <div style="background:#FEF3C7;border:1px solid ${cfg.color}33;border-radius:10px;padding:20px 24px;margin:16px 0;text-align:center;">
        <div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Balance Due</div>
        <div style="font-size:40px;font-weight:900;color:${cfg.color};letter-spacing:-0.5px;">$${Number(amountDue).toFixed(2)}</div>
        <div style="font-size:13px;color:#6B7280;margin-top:6px;">${daysOverdue} days past due · ${escHtml(invoiceNumber)}</div>
      </div>

      <div style="text-align:center;margin:24px 0;">
        <a href="${escHtml(paymentUrl)}" style="${BASE.btn(cfg.color)}">Pay $${Number(amountDue).toFixed(2)} Now →</a>
      </div>

      <p style="${BASE.p_sm}">${cfg.closing}</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">${escHtml(invoiceNumber)} · Reminder #${reminderNumber} · ${escHtml(businessName)}</p>`,
    cfg.color, brandName);
}

// ============================================================
// 4. PAYMENT RECEIPT
// ============================================================

export function invoiceReceiptTemplate({
  customerName, businessName, businessPhone, invoiceNumber,
  lineItems, subtotal, taxAmount, total,
  amountPaid, paymentMethod, paidAt, referenceId,
  brandName, primaryColor,
}) {
  const paidDate = paidAt ? new Date(paidAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Today';

  const content = `
    <div style="${BASE.body_p}">
      <div style="text-align:center;">
        <div style="width:64px;height:64px;background:#DCFCE7;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:28px;line-height:64px;">✅</div>
        <h1 style="${BASE.h1};text-align:center;">Payment Received</h1>
        <p style="${BASE.p};text-align:center;">Thank you, ${escHtml(customerName.split(' ')[0])}. Your payment to <strong>${escHtml(businessName)}</strong> is confirmed.</p>
      </div>

      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:20px 24px;margin:16px 0;text-align:center;">
        <div style="font-size:12px;color:#16A34A;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Amount Paid</div>
        <div style="font-size:40px;font-weight:900;color:#16A34A;letter-spacing:-0.5px;">$${Number(amountPaid).toFixed(2)}</div>
        <div style="font-size:13px;color:#6B7280;margin-top:6px;">${paidDate}</div>
      </div>

      <!-- Receipt details -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#F9FAFB;border-radius:8px;margin:16px 0;">
        <tr><td style="padding:10px 16px;font-size:13px;color:#6B7280;border-bottom:1px solid #E5E7EB;">Paid to</td><td style="padding:10px 16px;font-size:13px;color:#1A1A1A;font-weight:500;text-align:right;border-bottom:1px solid #E5E7EB;">${escHtml(businessName)}</td></tr>
        <tr><td style="padding:10px 16px;font-size:13px;color:#6B7280;border-bottom:1px solid #E5E7EB;">Invoice</td><td style="padding:10px 16px;font-size:13px;color:#1A1A1A;font-weight:500;text-align:right;border-bottom:1px solid #E5E7EB;">${escHtml(invoiceNumber)}</td></tr>
        <tr><td style="padding:10px 16px;font-size:13px;color:#6B7280;border-bottom:1px solid #E5E7EB;">Payment method</td><td style="padding:10px 16px;font-size:13px;color:#1A1A1A;font-weight:500;text-align:right;border-bottom:1px solid #E5E7EB;">${escHtml(paymentMethod)}</td></tr>
        ${referenceId ? `<tr><td style="padding:10px 16px;font-size:12px;color:#9CA3AF;">Reference</td><td style="padding:10px 16px;font-size:12px;color:#9CA3AF;text-align:right;font-family:monospace;">${escHtml(referenceId)}</td></tr>` : ''}
      </table>

      ${lineItems?.length ? `<details style="margin:16px 0"><summary style="font-size:13px;color:#6B7280;cursor:pointer;padding:8px 0">View invoice details</summary>${lineItemsHtml(lineItems)}${totalsHtml(subtotal, taxAmount, total)}</details>` : ''}

      <p style="${BASE.p_sm}">Keep this email as your receipt. Questions? Contact ${escHtml(businessName)}${businessPhone ? ` at ${escHtml(businessPhone)}` : ''}.</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">Payment receipt · ${escHtml(invoiceNumber)} · ${escHtml(businessName)}</p>`,
    '#16A34A', brandName);
}

// ============================================================
// 5. QUOTE DELIVERY
// ============================================================

export function quoteDeliveryTemplate({
  customerName, businessName, businessPhone, ownerName,
  quoteNumber, quoteTitle, description, lineItems,
  subtotal, taxAmount, total, validUntil,
  quoteUrl, acceptUrl, declineUrl, brandName, primaryColor,
}) {
  const validDate = validUntil ? new Date(validUntil).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '30 days';

  const content = `
    <div style="${BASE.body_p}">
      <p style="font-size:13px;color:#6B7280;margin:0 0 4px;">Quote for ${escHtml(customerName)}</p>
      <h1 style="${BASE.h1}">${escHtml(quoteTitle || 'Quote from ' + businessName)}</h1>
      <p style="${BASE.p}">Hi ${escHtml(customerName.split(' ')[0])}, ${escHtml(ownerName || businessName)} has prepared a quote for your review.</p>
      ${description ? `<p style="${BASE.p}">${escHtml(description)}</p>` : ''}

      <div style="background:#F9FAFB;border-radius:10px;padding:20px 24px;margin:16px 0;text-align:center;">
        <div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Quote Total</div>
        <div style="${BASE.amount}">$${Number(total).toFixed(2)}</div>
        <div style="font-size:13px;color:#6B7280;margin-top:6px;">Valid until ${validDate}</div>
        <div style="font-family:monospace;font-size:12px;color:#9CA3AF;margin-top:4px;">${escHtml(quoteNumber)}</div>
      </div>

      ${lineItemsHtml(lineItems)}
      ${totalsHtml(subtotal, taxAmount, total)}

      <div style="text-align:center;margin:28px 0 12px;">
        <a href="${escHtml(acceptUrl)}" style="${BASE.btn(primaryColor)}">Accept Quote →</a>
      </div>
      <div style="text-align:center;margin-bottom:8px;">
        <a href="${escHtml(declineUrl)}" style="font-size:13px;color:#9CA3AF;text-decoration:underline;">Decline this quote</a>
      </div>

      <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:13px;color:#1E40AF;font-weight:600;margin-bottom:4px;">What happens when you accept?</div>
        <div style="font-size:13px;color:#3B82F6;line-height:1.5;">We'll schedule the work and send you an invoice when it's complete. Accepting this quote does not require payment now.</div>
      </div>

      <p style="${BASE.p_sm}">Questions about this quote? Contact <strong>${escHtml(businessName)}</strong>${businessPhone ? ` at ${escHtml(businessPhone)}` : ''}.</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">Quote ${escHtml(quoteNumber)} · Valid until ${validDate} · ${escHtml(businessName)}</p>`,
    primaryColor, brandName);
}

// ============================================================
// 6. QUOTE ACCEPTED (to contractor)
// ============================================================

export function quoteAcceptedTemplate({
  ownerName, businessName, customerName, customerPhone,
  quoteNumber, total, dashUrl,
}) {
  const content = `
    <div style="${BASE.body_p}">
      <div style="text-align:center;font-size:40px;margin-bottom:12px;">🎉</div>
      <h1 style="${BASE.h1};text-align:center;">Quote accepted!</h1>
      <p style="${BASE.p};text-align:center;"><strong>${escHtml(customerName)}</strong> accepted your quote for <strong>$${Number(total).toFixed(2)}</strong>.</p>

      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:16px 20px;margin:16px 0;">
        <div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Customer Details</div>
        <div style="font-size:15px;font-weight:600;color:#1A1A1A;margin-bottom:4px;">${escHtml(customerName)}</div>
        ${customerPhone ? `<div style="font-size:14px;color:#6B7280;"><a href="tel:${escHtml(customerPhone.replace(/\D/g,''))}" style="color:#16A34A;text-decoration:none;">${escHtml(customerPhone)}</a></div>` : ''}
        <div style="font-size:13px;color:#6B7280;margin-top:4px;">Quote ${escHtml(quoteNumber)}</div>
      </div>

      <p style="${BASE.p}">An invoice has been created automatically. Once you complete the work, the Collector agent will send it and handle payment collection.</p>

      <div style="text-align:center;margin:24px 0;">
        <a href="${escHtml(dashUrl)}" style="${BASE.btn('#16A34A')}">View in Dashboard →</a>
      </div>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">${escHtml(businessName)} · Quote ${escHtml(quoteNumber)}</p>`,
    '#16A34A', 'CrewBox');
}

// ============================================================
// 7. DOCUMENT EXPIRY ALERT
// ============================================================

export function documentExpiryTemplate({
  ownerName, businessName, documentType,
  expiryDate, daysUntilExpiry, uploadUrl, brandName,
}) {
  const formattedDate = new Date(expiryDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const isUrgent = daysUntilExpiry <= 7;
  const alertColor = isUrgent ? '#EF4444' : '#F59E0B';

  const content = `
    <div style="${BASE.body_p}">
      <div style="text-align:center;font-size:36px;margin-bottom:12px;">${isUrgent ? '🚨' : '⚠️'}</div>
      <h1 style="${BASE.h1};text-align:center;color:${alertColor};">${daysUntilExpiry} days until expiry</h1>
      <p style="${BASE.p}">Hi ${escHtml(ownerName.split(' ')[0])}, your <strong>${escHtml(documentType)}</strong> for <strong>${escHtml(businessName)}</strong> expires on <strong>${formattedDate}</strong>.</p>

      <div style="background:${isUrgent ? '#FEE2E2' : '#FEF3C7'};border:1px solid ${alertColor}44;border-radius:10px;padding:16px 20px;margin:16px 0;">
        <div style="font-size:14px;font-weight:600;color:${alertColor};margin-bottom:4px;">${escHtml(documentType)}</div>
        <div style="font-size:13px;color:#6B7280;">Expires: <strong>${formattedDate}</strong> — in ${daysUntilExpiry} days</div>
      </div>

      <p style="${BASE.p}">To keep your account active and avoid any disruption to your ${escHtml(brandName)} services, please upload a renewed document before the expiry date.</p>

      <div style="text-align:center;margin:24px 0;">
        <a href="${escHtml(uploadUrl)}" style="${BASE.btn(alertColor)}">Upload Renewal →</a>
      </div>

      <p style="${BASE.p_sm}">Uploading takes less than 2 minutes. Your document is stored securely and encrypted.</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">${escHtml(businessName)} · Document expiry alert</p>`,
    alertColor, brandName);
}

// ============================================================
// 8. LICENSEE WELCOME
// ============================================================

export function licenseeWelcomeTemplate({
  ownerName, companyName, tier, maxClients, portalUrl, trialEndsAt,
}) {
  const trialDate = trialEndsAt ? new Date(trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : '14 days from now';
  const tierName = { starter: 'Starter', growth: 'Growth', enterprise: 'Enterprise' }[tier] || 'Growth';

  const content = `
    <div style="${BASE.body_p}">
      <h1 style="${BASE.h1}">Welcome to CrewBox, ${escHtml(ownerName.split(' ')[0])}.</h1>
      <p style="${BASE.p}">Your white-label AI platform is set up and ready. Here's what you have access to as a <strong>${tierName} licensee</strong>:</p>

      <div style="background:#F9FAFB;border-radius:10px;padding:20px;margin:16px 0;">
        <div style="font-size:13px;color:#374151;padding:8px 0;border-bottom:1px solid #E5E7EB;display:flex;justify-content:space-between;"><span style="color:#6B7280;">Plan</span><strong>${tierName} License</strong></div>
        <div style="font-size:13px;color:#374151;padding:8px 0;border-bottom:1px solid #E5E7EB;display:flex;justify-content:space-between;"><span style="color:#6B7280;">Client accounts</span><strong>Up to ${maxClients === 9999 ? 'unlimited' : maxClients}</strong></div>
        <div style="font-size:13px;color:#374151;padding:8px 0;border-bottom:1px solid #E5E7EB;display:flex;justify-content:space-between;"><span style="color:#6B7280;">Trial ends</span><strong>${trialDate}</strong></div>
        <div style="font-size:13px;color:#374151;padding:8px 0;display:flex;justify-content:space-between;"><span style="color:#6B7280;">AI agents per client</span><strong>All 5 included</strong></div>
      </div>

      <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:14px 16px;margin:16px 0;">
        <div style="font-size:14px;font-weight:600;color:#92400E;margin-bottom:4px;">Your next step</div>
        <div style="font-size:13px;color:#78350F;line-height:1.5;">Add your first contractor client. It takes 3 minutes. They'll be up and running with all 5 AI agents immediately.</div>
      </div>

      <div style="text-align:center;margin:24px 0;">
        <a href="${escHtml(portalUrl)}" style="${BASE.btn('#F5C800')};color:#111;">Go to Partner Portal →</a>
      </div>

      <p style="${BASE.p_sm}">Your trial runs until ${trialDate}. No credit card charge until then. Cancel anytime.</p>
    </div>`;

  return emailShell(content,
    `<p style="${BASE.foot_p}">${escHtml(companyName)} · CrewBox Partner</p>
     <p style="${BASE.foot_p}"><a href="${escHtml(portalUrl)}" style="color:#9CA3AF;">Partner Portal</a> · <a href="mailto:support@getcrewbox.com" style="color:#9CA3AF;">Support</a></p>`,
    '#F5C800', 'CrewBox');
}

// ── HELPER ────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
