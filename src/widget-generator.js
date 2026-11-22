/**
 * Generators for ready-to-embed Click-to-WhatsApp HTML/JS floating widgets
 * and standalone Link-in-Bio HTML pages (100% Meta/Facebook API free).
 */

import { buildWhatsAppUrl } from './engine.js';

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateWidgetSnippet({
  phone,
  message,
  campaign = 'website-widget',
  brandName = 'Nasz Zespół',
  greeting = 'Masz pytanie? Napisz na WhatsApp!',
  buttonLabel = 'WhatsApp',
  accentColor = '#25D366',
  position = 'right',
}) {
  const waUrl = buildWhatsAppUrl({
    phone,
    text: message,
    campaign,
    source: 'widget',
    brand: brandName,
  });

  const sideCss = position === 'left' ? 'left: 20px;' : 'right: 20px;';
  const alignCss = position === 'left' ? 'align-items: flex-start;' : 'align-items: flex-end;';

  return `<!-- Click-to-WhatsApp Widget (bez Facebook/Meta API) -->
<div id="ctwa-widget" style="position:fixed;bottom:20px;${sideCss}z-index:99999;display:flex;flex-direction:column;${alignCss}gap:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div id="ctwa-bubble" style="background:#ffffff;color:#0f172a;padding:10px 14px;border-radius:14px;box-shadow:0 10px 25px rgba(15,23,42,0.16);font-size:13px;max-width:240px;line-height:1.4;border:1px solid #e2e8f0;position:relative;">
    <strong style="display:block;font-size:12px;color:#059669;margin-bottom:2px;">${escapeHtml(brandName)}</strong>
    <span>${escapeHtml(greeting)}</span>
    <button type="button" onclick="document.getElementById('ctwa-bubble').style.display='none'" aria-label="Zamknij" style="position:absolute;top:4px;right:6px;border:none;background:transparent;color:#94a3b8;cursor:pointer;font-size:14px;">×</button>
  </div>
  <a href="${escapeHtml(waUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;background:${escapeHtml(accentColor)};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:999px;box-shadow:0 8px 20px rgba(37,211,102,0.35);transition:transform .15s ease;">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.07 0C5.5 0 .16 5.34.16 11.91c0 2.1.55 4.15 1.59 5.96L0 24l6.3-1.65a11.86 11.86 0 0 0 5.77 1.47h.01c6.57 0 11.91-5.34 11.91-11.91 0-3.18-1.24-6.17-3.47-8.43ZM12.08 21.8h-.01a9.87 9.87 0 0 1-5.04-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.52-5.26c0-5.46 4.44-9.9 9.91-9.9 2.65 0 5.14 1.03 7.01 2.9a9.84 9.84 0 0 1 2.9 7.01c0 5.46-4.45 9.88-9.91 9.88Zm5.43-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.08-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.21 5.09 4.5.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35Z"/></svg>
    <span>${escapeHtml(buttonLabel)}</span>
  </a>
</div>`;
}
