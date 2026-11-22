/**
 * Core Social Media Automation Engine (Comment-to-DM & Click-to-WhatsApp).
 * Zero external dependencies — works identically in browsers (GitHub Pages)
 * and Node.js (GitHub Actions Comment Bot & local server).
 */

const POLISH_MAP = {
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z',
};

export function normalizeText(text, ignoreDiacritics = true) {
  if (typeof text !== 'string') return '';
  let result = text.trim().toLowerCase();
  if (ignoreDiacritics) {
    result = result.replace(/[ąćęłńóśźż]/g, (ch) => POLISH_MAP[ch] || ch);
    result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  return result;
}

export function sanitizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D+/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  // If user typed a standard 9-digit Polish mobile number without prefix, add 48
  if (digits.length === 9 && /^[4-9]/.test(digits)) {
    digits = '48' + digits;
  }
  return digits;
}

export function renderTemplate(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

export function buildTrackedStoreUrl(rawUrl, { source = 'social', campaign = 'serviceapp-download', ref = '' } = {}) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.includes('play.google.com')) {
      const utm = [
        `utm_source=${source}`,
        'utm_medium=social_bot',
        `utm_campaign=${campaign}`,
        ref ? `utm_content=${ref}` : '',
      ]
        .filter(Boolean)
        .join('&');
      parsed.searchParams.set('referrer', utm);
      return parsed.toString();
    }
    if (parsed.hostname.includes('apps.apple.com')) {
      parsed.searchParams.set('ct', `${source}_${campaign}${ref ? '_' + ref : ''}`.slice(0, 40));
      parsed.searchParams.set('mt', '8');
      return parsed.toString();
    }
    parsed.searchParams.set('utm_source', source);
    parsed.searchParams.set('utm_medium', 'social_bot');
    parsed.searchParams.set('utm_campaign', campaign);
    if (ref) parsed.searchParams.set('utm_content', ref);
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function buildWhatsAppUrl({
  phone,
  text = '',
  campaign = '',
  source = '',
  username = '',
  keyword = '',
  brand = '',
  appName = '',
  appUrl = '',
  androidUrl = '',
  iosUrl = '',
}) {
  const cleanPhone = sanitizePhone(phone);
  if (!cleanPhone) {
    return '';
  }
  const rendered = renderTemplate(text, {
    campaign,
    source,
    username,
    keyword,
    brand,
    app_name: appName || brand,
    app_url: appUrl,
    android_url: androidUrl,
    ios_url: iosUrl,
  }).trim();

  const base = `https://wa.me/${cleanPhone}`;
  if (!rendered) return base;
  return `${base}?text=${encodeURIComponent(rendered)}`;
}

export function matchKeyword(commentText, keyword, matchMode = 'contains', ignoreDiacritics = true) {
  if (!keyword || !commentText) return false;

  if (matchMode === 'regex') {
    try {
      const target = ignoreDiacritics ? normalizeText(commentText, true) : commentText;
      const re = new RegExp(keyword, 'i');
      return re.test(target);
    } catch {
      return false;
    }
  }

  const normComment = normalizeText(commentText, ignoreDiacritics);
  const normKeyword = normalizeText(keyword, ignoreDiacritics);
  if (!normKeyword) return false;

  if (matchMode === 'exact') {
    return normComment === normKeyword;
  }
  if (matchMode === 'startsWith') {
    return normComment.startsWith(normKeyword);
  }
  // default: contains (word-aware when possible, fallback substring for phrases)
  return normComment.includes(normKeyword);
}

export function matchRule(commentText, rules = [], options = {}) {
  const { channel = null } = options;

  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (channel && Array.isArray(rule.channels) && rule.channels.length > 0) {
      if (!rule.channels.includes(channel)) continue;
    }
    const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
    const matchMode = rule.matchMode || 'contains';
    const ignoreDiacritics = rule.ignoreDiacritics !== false;

    for (const kw of keywords) {
      if (matchKeyword(commentText, kw, matchMode, ignoreDiacritics)) {
        return { matched: true, rule, keyword: kw };
      }
    }
  }

  return { matched: false, rule: null, keyword: null };
}

export function pickVariant(variants, seedIndex = null) {
  if (!Array.isArray(variants) || variants.length === 0) return '';
  if (typeof seedIndex === 'number' && Number.isFinite(seedIndex)) {
    return variants[Math.abs(seedIndex) % variants.length];
  }
  const idx = Math.floor(Math.random() * variants.length);
  return variants[idx];
}

export function extractContactInfo(text = '') {
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = text.match(/(?:\+?\d[\d\s-]{7,15}\d)/);

  const email = emailMatch ? emailMatch[0] : '';
  const phone = phoneMatch ? sanitizePhone(phoneMatch[0]) : '';
  const hasContact = Boolean(email || (phone && phone.length >= 9));

  return {
    email,
    phone: phone && phone.length >= 9 ? phone : '',
    hasContact,
  };
}

/**
 * Process an incoming social media or GitHub comment against configured rules.
 *
 * @param {object} event - { username, comment, channel, postId, timestamp }
 * @param {object} config - Full config object (rules.json structure)
 * @param {object} state - Cooldown state map: { [userRuleKey]: lastTimestampMs }
 */
export function processComment(event, config, state = {}) {
  const now = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
  const username = (event.username || '@uzytkownik').trim();
  const comment = (event.comment || '').trim();
  const channel = event.channel || 'instagram';

  const match = matchRule(comment, config.rules || [], { channel });
  if (!match.matched) {
    return {
      matched: false,
      skippedReason: 'no_keyword_match',
      timestamp: new Date(now).toISOString(),
    };
  }

  const { rule, keyword } = match;
  const cooldownMs = Math.max(0, Number(rule.cooldownMinutes || 0)) * 60 * 1000;
  const cooldownKey = `${normalizeText(username)}::${rule.id}`;
  const lastTriggered = state[cooldownKey] || 0;

  if (cooldownMs > 0 && lastTriggered && now - lastTriggered < cooldownMs) {
    const remainingSec = Math.ceil((cooldownMs - (now - lastTriggered)) / 1000);
    return {
      matched: true,
      skippedReason: 'cooldown_active',
      remainingSeconds: remainingSec,
      rule,
      keyword,
      timestamp: new Date(now).toISOString(),
    };
  }

  const waPhone = config.whatsapp?.phone || '';
  const brandName = config.brand?.name || 'ServiceApp';
  const campaign = config.whatsapp?.defaultCampaign || `${channel}-${rule.id}`;
  const rawLinks = config.appLinks || {};
  const appLinks = {
    web: buildTrackedStoreUrl(rawLinks.web || 'https://serviceapp.mobi', { source: channel, campaign, ref: rule.id }),
    android: buildTrackedStoreUrl(rawLinks.android || '', { source: channel, campaign, ref: rule.id }),
    ios: buildTrackedStoreUrl(rawLinks.ios || '', { source: channel, campaign, ref: rule.id }),
  };

  const whatsappUrl = buildWhatsAppUrl({
    phone: waPhone,
    text: rule.whatsappCtaText || config.whatsapp?.defaultMessage || '',
    campaign,
    source: channel,
    username,
    keyword,
    brand: brandName,
    appName: brandName,
    appUrl: appLinks.web,
    androidUrl: appLinks.android,
    iosUrl: appLinks.ios,
  });

  const templateVars = {
    username,
    keyword,
    comment,
    whatsapp_link: whatsappUrl,
    campaign,
    source: channel,
    brand: brandName,
    app_name: brandName,
    app_url: appLinks.web,
    android_url: appLinks.android,
    ios_url: appLinks.ios,
  };

  const publicReplyTemplate = pickVariant(rule.publicReplies, event.variantSeed);
  const publicReply = renderTemplate(publicReplyTemplate, templateVars);
  const dmMessage = renderTemplate(rule.dmMessage || '', templateVars);

  const quickReplies = (rule.quickReplies || []).map((qr) => ({
    ...qr,
    reply: renderTemplate(qr.reply || '', templateVars),
    actionUrl: qr.actionUrl ? renderTemplate(qr.actionUrl, templateVars) : '',
    whatsappUrl: qr.openWhatsApp
      ? buildWhatsAppUrl({
          phone: waPhone,
          text: qr.whatsappText || rule.whatsappCtaText || config.whatsapp?.defaultMessage || '',
          campaign,
          source: channel,
          username,
          keyword,
          brand: brandName,
          appName: brandName,
          appUrl: appLinks.web,
          androidUrl: appLinks.android,
          iosUrl: appLinks.ios,
        })
      : '',
  }));

  // Record cooldown timestamp in state map
  state[cooldownKey] = now;

  const leadCandidate = {
    id: `lead_${now}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date(now).toISOString(),
    username,
    channel,
    ruleId: rule.id,
    ruleName: rule.name,
    keyword,
    comment,
    status: 'Nowy',
    tag: rule.id,
    email: '',
    phone: '',
    notes: '',
    whatsappUrl,
  };

  return {
    matched: true,
    skippedReason: null,
    rule,
    keyword,
    publicReply,
    dmMessage,
    whatsappUrl,
    appLinks,
    quickReplies,
    leadCandidate,
    timestamp: new Date(now).toISOString(),
  };
}

export function buildOutboundWebhookPayload(lead, format = 'generic') {
  if (format === 'discord') {
    return {
      content: `🎯 **Nowy lead z bota (${lead.channel})**`,
      embeds: [
        {
          title: `${lead.username} — ${lead.ruleName || lead.tag}`,
          color: 2479974,
          fields: [
            { name: 'Słowo kluczowe', value: lead.keyword || '-', inline: true },
            { name: 'Status', value: lead.status || 'Nowy', inline: true },
            { name: 'Komentarz', value: lead.comment || '-' },
            { name: 'Kontakt', value: [lead.email, lead.phone].filter(Boolean).join(' / ') || 'Brak' },
          ],
          timestamp: lead.createdAt,
        },
      ],
    };
  }

  if (format === 'slack') {
    return {
      text: `🎯 Nowy lead (${lead.channel}): *${lead.username}* | Reguła: ${lead.ruleName || lead.tag} | Słowo: \`${lead.keyword}\` | Kontakt: ${[lead.email, lead.phone].filter(Boolean).join(' / ') || 'brak'}`,
    };
  }

  return {
    event: 'social_bot.lead_captured',
    lead,
  };
}

export function leadsToCsv(leads = []) {
  const headers = [
    'ID',
    'Data',
    'Użytkownik',
    'Kanał',
    'Reguła',
    'Słowo kluczowe',
    'Status',
    'E-mail',
    'Telefon',
    'Komentarz',
    'Notatki',
    'Link WhatsApp',
  ];

  const escapeCell = (val) => {
    const str = String(val ?? '');
    if (/[",\n\r;]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = leads.map((l) =>
    [
      l.id,
      l.createdAt,
      l.username,
      l.channel,
      l.ruleName,
      l.keyword,
      l.status,
      l.email,
      l.phone,
      l.comment,
      l.notes,
      l.whatsappUrl,
    ]
      .map(escapeCell)
      .join(';')
  );

  // UTF-8 BOM + semicolon separator for Polish Excel compatibility
  return '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
}
