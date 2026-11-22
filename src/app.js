import {
  buildOutboundWebhookPayload,
  buildWhatsAppUrl,
  extractContactInfo,
  leadsToCsv,
  processComment,
} from './engine.js';
import { generateQrSvg } from './qr.js';
import {
  detectServer,
  dispatchWebhook,
  loadConfig,
  loadLeads,
  resetConfigToDefault,
  saveConfig,
  saveLeads,
} from './storage.js';
import { generateWidgetSnippet } from './widget-generator.js';

let config = null;
let leads = [];
let cooldownState = {};
let activeSimLeadId = null;
let simComments = [];
let simDmHistory = [];
let simLogs = [];
let widgetPreviewVisible = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('pl-PL', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso || '';
  }
}

function addLog(message) {
  const ts = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  simLogs.unshift(`[${ts}] ${message}`);
  if (simLogs.length > 40) simLogs.pop();
  renderLogs();
}

function downloadFile(filename, content, mimeType = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text, label = 'Skopiowano do schowka!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(label);
  }
}

/* ==================== TABS ==================== */
function setupTabs() {
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${target}`));
    });
  });
}

/* ==================== RENDER HEADER & COUNTS ==================== */
function renderHeader() {
  const brand = config.brand || {};
  $('#brand-avatar').textContent = brand.avatarText || 'SB';
  $('#sim-post-avatar').textContent = brand.avatarText || 'MM';
  $('#sim-post-handle').textContent = brand.handle || '@mojamarka';
  $('#rules-count').textContent = String((config.rules || []).length);
  $('#leads-count').textContent = String(leads.length);
}

/* ==================== TAB 1: SIMULATOR ==================== */
function renderSimQuickKeywords() {
  const container = $('#sim-quick-keywords');
  const samples = [];
  for (const rule of config.rules || []) {
    if (rule.enabled !== false && rule.keywords?.length) {
      samples.push(rule.keywords[0].toUpperCase());
    }
  }
  const unique = [...new Set(samples)].slice(0, 6);
  container.innerHTML = unique
    .map((kw) => `<button type="button" class="chip" data-sample="${esc(kw)}">Kliknij: "${esc(kw)}"</button>`)
    .join('');

  container.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#sim-comment-input').value = `Hej! Poproszę ${chip.dataset.sample}`;
      handleSimCommentSubmit();
    });
  });
}

function renderComments() {
  const feed = $('#sim-comments-feed');
  if (simComments.length === 0) {
    feed.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:12.5px;padding:18px 8px;">Brak komentarzy. Napisz np. <strong>CENNIK</strong> lub kliknij przycisk powyżej.</div>`;
    return;
  }

  feed.innerHTML = simComments
    .map(
      (c) => `
      <div class="comment-item ${c.isBot ? 'bot-reply' : ''}">
        <span class="comment-author">${esc(c.author)}</span>
        <span>${esc(c.text)}</span>
        <span class="comment-time">${esc(formatTime(c.timestamp))}</span>
      </div>`
    )
    .join('');
  feed.scrollTop = feed.scrollHeight;
}

function renderDmMessages() {
  const box = $('#sim-dm-messages');
  if (simDmHistory.length === 0) {
    box.innerHTML = `<div class="dm-bubble system">Dodaj komentarz po lewej stronie (lub kliknij przycisk słowa kluczowego), aby uruchomić automatyczną wiadomość DM.</div>`;
    return;
  }

  box.innerHTML = simDmHistory
    .map((msg, idx) => {
      let extra = '';
      if (msg.actionUrl) {
        extra += `<div><a class="dm-wa-cta" style="background:#0284c7;color:#ffffff;" href="${esc(msg.actionUrl)}" target="_blank" rel="noopener noreferrer">${esc(msg.actionLabel || 'Pobierz ServiceApp')} ↗</a></div>`;
      }
      if (msg.whatsappUrl) {
        extra += `<div><a class="dm-wa-cta" href="${esc(msg.whatsappUrl)}" target="_blank" rel="noopener noreferrer" data-wa-lead="${esc(msg.leadId || '')}">📲 Przejdź na WhatsApp (wa.me) ↗</a></div>`;
      }
      if (msg.quickReplies?.length) {
        extra += `<div class="dm-quick-replies">${msg.quickReplies
          .map(
            (qr, qIdx) =>
              `<button type="button" class="dm-qr-btn" data-msg-idx="${idx}" data-qr-idx="${qIdx}">${esc(qr.label)}</button>`
          )
          .join('')}</div>`;
      }
      return `<div class="dm-bubble ${esc(msg.sender)}">${esc(msg.text)}${extra}</div>`;
    })
    .join('');

  box.querySelectorAll('.dm-qr-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mIdx = Number(btn.dataset.msgIdx);
      const qIdx = Number(btn.dataset.qrIdx);
      const qr = simDmHistory[mIdx]?.quickReplies?.[qIdx];
      if (!qr) return;
      handleQuickReplyClick(qr);
    });
  });

  box.querySelectorAll('.dm-wa-cta').forEach((link) => {
    link.addEventListener('click', () => {
      const leadId = link.dataset.waLead;
      if (leadId) {
        updateLeadStatus(leadId, 'Przekierowany na WhatsApp');
      }
      addLog('Kliknięto przycisk Click-to-WhatsApp (otwieranie wa.me).');
    });
  });

  box.scrollTop = box.scrollHeight;
}

function renderLogs() {
  const box = $('#sim-log-box');
  if (simLogs.length === 0) {
    box.innerHTML = `<div class="log-line" style="color:var(--text-muted);">Gotowy do testów. Wszystkie zdarzenia pojawią się tutaj.</div>`;
    return;
  }
  box.innerHTML = simLogs.map((l) => `<div class="log-line">${esc(l)}</div>`).join('');
}

async function handleSimCommentSubmit() {
  const username = $('#sim-username').value.trim() || '@uzytkownik';
  const comment = $('#sim-comment-input').value.trim();
  const channel = $('#sim-channel').value;
  if (!comment) return;

  $('#sim-comment-input').value = '';
  const nowIso = new Date().toISOString();

  simComments.push({
    author: username,
    text: comment,
    isBot: false,
    timestamp: nowIso,
  });

  const result = processComment({ username, comment, channel, timestamp: nowIso }, config, cooldownState);

  if (!result.matched) {
    addLog(`Brak dopasowania dla komentarza "${comment}" (${channel}).`);
    renderComments();
    return;
  }

  if (result.skippedReason === 'cooldown_active') {
    addLog(`Anty-spam: pominięto ${username} dla reguły "${result.rule.name}" (zostało ${result.remainingSeconds}s).`);
    simDmHistory.push({
      sender: 'system',
      text: `Anty-spam cooldown aktywny dla ${username} (${result.remainingSeconds}s). Kliknij „Wyczyść cooldown”, aby przetestować ponownie.`,
    });
    renderComments();
    renderDmMessages();
    return;
  }

  // Public reply under the comment
  if (result.publicReply) {
    simComments.push({
      author: `${config.brand?.handle || '@bot'} [BOT]`,
      text: result.publicReply,
      isBot: true,
      timestamp: result.timestamp,
    });
  }

  // Save lead
  const lead = result.leadCandidate;
  leads.unshift(lead);
  activeSimLeadId = lead.id;
  await saveLeads(leads);
  renderHeader();
  renderLeads();

  // Send optional outbound webhook
  if (config.webhook?.enabled && config.webhook?.url) {
    const payload = buildOutboundWebhookPayload(lead, config.webhook.format);
    dispatchWebhook(config.webhook, payload).then((res) => {
      if (res.sent) addLog(`Webhook wysłany poprawnie (HTTP ${res.status}).`);
      else if (res.error) addLog(`Webhook błąd: ${res.error}`);
    });
  }

  // Push automated DM message
  $('#sim-active-user').textContent = `Rozmowa z ${username}`;
  $('#dm-thread-title').textContent = `DM: ${username} (${channel})`;

  simDmHistory.push({
    sender: 'system',
    text: `Reguła "${result.rule.name}" uruchomiona słowem "${result.keyword}"`,
  });

  simDmHistory.push({
    sender: 'bot',
    text: result.dmMessage,
    whatsappUrl: result.whatsappUrl,
    quickReplies: result.quickReplies,
    leadId: lead.id,
  });

  addLog(`Dopasowano "${result.rule.name}" (słowo: "${result.keyword}") → wysłano odpowiedź + DM + zapisano leada.`);
  renderComments();
  renderDmMessages();
}

async function handleQuickReplyClick(qr) {
  simDmHistory.push({ sender: 'user', text: qr.label });

  const lead = leads.find((l) => l.id === activeSimLeadId);
  if (lead && qr.leadTag) {
    lead.notes = [lead.notes, `Wybrano: ${qr.leadTag}`].filter(Boolean).join(' | ');
    if (qr.openWhatsApp) {
      lead.status = 'Przekierowany na WhatsApp';
    }
    await saveLeads(leads);
    renderLeads();
  }

  simDmHistory.push({
    sender: 'bot',
    text: qr.reply,
    actionUrl: qr.actionUrl || '',
    actionLabel: qr.actionLabel || '',
    whatsappUrl: qr.openWhatsApp ? qr.whatsappUrl : '',
    leadId: activeSimLeadId,
  });

  addLog(`Użytkownik kliknął opcję "${qr.label}".`);
  renderDmMessages();
}

async function handleSimDmReply() {
  const input = $('#sim-dm-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  simDmHistory.push({ sender: 'user', text });

  const contact = extractContactInfo(text);
  const lead = leads.find((l) => l.id === activeSimLeadId);

  if (contact.hasContact) {
    if (lead) {
      if (contact.email) lead.email = contact.email;
      if (contact.phone) lead.phone = contact.phone;
      lead.status = 'Zakwalifikowany';
      lead.notes = [lead.notes, text].filter(Boolean).join(' | ');
      await saveLeads(leads);
      renderLeads();
    }

    const waUrl = buildWhatsAppUrl({
      phone: config.whatsapp?.phone,
      text: `Cześć! Zostawiłem dane w DM (${contact.email || contact.phone}) i chcę dokończyć rozmowę.`,
      campaign: 'dm-qualified',
      brand: config.brand?.name,
    });

    simDmHistory.push({
      sender: 'bot',
      text: `Dzięki! Zapisałem Twoje dane kontaktowe (${[contact.email, contact.phone].filter(Boolean).join(', ')}). Nasz zespół odezwie się wkrótce — albo kliknij poniżej, jeśli chcesz porozmawiać od razu na WhatsApp:`,
      whatsappUrl: waUrl,
      leadId: activeSimLeadId,
    });
    addLog(`Zapisano dane kontaktowe leada: ${contact.email || ''} ${contact.phone || ''}.`);
  } else {
    if (lead) {
      lead.notes = [lead.notes, `DM: ${text}`].filter(Boolean).join(' | ');
      await saveLeads(leads);
      renderLeads();
    }
    const waUrl = buildWhatsAppUrl({
      phone: config.whatsapp?.phone,
      text: `Cześć! Piszę w sprawie: ${text}`,
      campaign: 'dm-fallback',
      brand: config.brand?.name,
    });
    simDmHistory.push({
      sender: 'bot',
      text: 'Dzięki za wiadomość! Jeśli chcesz otrzymać wycenę, podaj swój e-mail lub numer telefonu — albo napisz do nas bezpośrednio na WhatsApp:',
      whatsappUrl: waUrl,
      leadId: activeSimLeadId,
    });
  }

  renderDmMessages();
}

/* ==================== TAB 2: CLICK-TO-WHATSAPP STUDIO ==================== */
function populateWhatsAppForm() {
  $('#wa-phone').value = config.whatsapp?.phone || '';
  $('#wa-brand-name').value = config.brand?.name || 'ServiceApp';
  $('#wa-campaign').value = config.whatsapp?.defaultCampaign || 'serviceapp-download';
  $('#wa-position').value = config.whatsapp?.widgetPosition || 'right';
  $('#wa-message').value = config.whatsapp?.defaultMessage || '';
  $('#wa-greeting').value = config.whatsapp?.greetingBubble || '';
  $('#wa-btn-label').value = config.whatsapp?.buttonLabel || 'Pobierz ServiceApp / WhatsApp';
  $('#wa-app-web').value = config.appLinks?.web || 'https://serviceapp.mobi';
  $('#wa-app-android').value = config.appLinks?.android || '';
  $('#wa-app-ios').value = config.appLinks?.ios || '';
  refreshWhatsAppOutputs();
}

function getWhatsAppDraft() {
  return {
    phone: $('#wa-phone').value.trim(),
    brandName: $('#wa-brand-name').value.trim() || 'ServiceApp',
    campaign: $('#wa-campaign').value.trim() || 'serviceapp-download',
    position: $('#wa-position').value,
    message: $('#wa-message').value,
    greeting: $('#wa-greeting').value.trim() || 'Pobierz ServiceApp lub napisz na WhatsApp!',
    buttonLabel: $('#wa-btn-label').value.trim() || 'Pobierz ServiceApp / WhatsApp',
    appWeb: $('#wa-app-web').value.trim() || 'https://serviceapp.mobi',
    appAndroid: $('#wa-app-android').value.trim(),
    appIos: $('#wa-app-ios').value.trim(),
  };
}

function buildChannelLandingUrl(channel, draft) {
  const bioParams = new URLSearchParams();
  bioParams.set('src', channel);
  if (draft.phone) bioParams.set('phone', draft.phone);
  if (draft.brandName) bioParams.set('brand', draft.brandName);
  if (draft.campaign) bioParams.set('campaign', draft.campaign);
  if (draft.appWeb) bioParams.set('web', draft.appWeb);
  if (draft.appAndroid) bioParams.set('android', draft.appAndroid);
  if (draft.appIos) bioParams.set('ios', draft.appIos);
  return new URL(`./whatsapp.html?${bioParams.toString()}`, window.location.href).toString();
}

function refreshWhatsAppOutputs() {
  const draft = getWhatsAppDraft();
  const waUrl = buildWhatsAppUrl({
    phone: draft.phone,
    text: draft.message,
    campaign: draft.campaign,
    source: 'social',
    brand: draft.brandName,
    appName: draft.brandName,
    appUrl: draft.appWeb,
    androidUrl: draft.appAndroid,
    iosUrl: draft.appIos,
  });

  $('#wa-generated-url').textContent = waUrl || 'Wpisz poprawny numer telefonu, aby wygenerować link wa.me';
  $('#btn-test-wa-url').href = waUrl || '#';

  const bioHref = buildChannelLandingUrl('instagram', draft);
  $('#btn-open-bio-page').href = bioHref;
  $('#open-landing-btn').href = bioHref;

  // Render offline SVG QR code
  const qrBox = $('#wa-qr-container');
  if (waUrl) {
    try {
      qrBox.innerHTML = generateQrSvg(waUrl, { pixelSize: 196, margin: 3 });
    } catch (err) {
      qrBox.innerHTML = `<div style="padding:16px;font-size:12px;color:#b91c1c;">${esc(err.message)}</div>`;
    }
  } else {
    qrBox.innerHTML = `<div style="padding:24px;font-size:12px;color:#64748b;">Brak numeru</div>`;
  }

  // Render HTML Widget snippet
  const snippet = generateWidgetSnippet({
    phone: draft.phone,
    message: draft.message,
    campaign: draft.campaign,
    brandName: draft.brandName,
    greeting: draft.greeting,
    buttonLabel: draft.buttonLabel,
    accentColor: config.brand?.accentColor || '#25D366',
    position: draft.position,
  });
  $('#wa-widget-code').textContent = snippet;

  if (widgetPreviewVisible) {
    $('#live-widget-mount').innerHTML = snippet;
  }
}

function downloadQrPng() {
  const svgEl = $('#wa-qr-container svg');
  if (!svgEl) {
    showToast('Najpierw wygeneruj kod QR.');
    return;
  }
  const svgStr = new XMLSerializer().serializeToString(svgEl);
  const img = new Image();
  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 600);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, 600, 600);
    URL.revokeObjectURL(url);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const dlUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = 'click-to-whatsapp-qr.png';
      a.click();
      URL.revokeObjectURL(dlUrl);
    }, 'image/png');
  };
  img.src = url;
}

/* ==================== TAB 3: RULES ==================== */
function renderRulesList() {
  const list = $('#rules-list');
  const rules = config.rules || [];

  if (rules.length === 0) {
    list.innerHTML = `<div style="color:var(--text-muted);font-size:13px;">Brak reguł. Dodaj nową regułę przyciskiem powyżej.</div>`;
    return;
  }

  list.innerHTML = rules
    .map(
      (r) => `
      <div class="rule-item">
        <div class="rule-item-head">
          <div>
            <strong>${esc(r.name)}</strong>
            <span class="pill ${r.enabled !== false ? 'green' : ''}" style="margin-left:8px;padding:2px 8px;font-size:11px;">
              ${r.enabled !== false ? 'Aktywna' : 'Wyłączona'}
            </span>
          </div>
          <div class="btn-group">
            <button class="btn btn-sm" data-action="toggle" data-id="${esc(r.id)}">${r.enabled !== false ? 'Wyłącz' : 'Włącz'}</button>
            <button class="btn btn-sm btn-blue" data-action="edit" data-id="${esc(r.id)}">Edytuj</button>
            <button class="btn btn-sm btn-danger" data-action="delete" data-id="${esc(r.id)}">Usuń</button>
          </div>
        </div>
        <div style="margin-top:8px;">
          ${(r.keywords || []).map((k) => `<span class="kw-tag">${esc(k)}</span>`).join('')}
        </div>
        <div style="margin-top:8px;font-size:12px;color:var(--text-muted);">
          Tryb: <code>${esc(r.matchMode || 'contains')}</code> · Cooldown: ${Number(r.cooldownMinutes || 0)} min · Warianty odpowiedzi: ${(r.publicReplies || []).length}
        </div>
      </div>`
    )
    .join('');

  list.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const idx = config.rules.findIndex((r) => r.id === id);
      if (idx === -1) return;

      if (action === 'toggle') {
        config.rules[idx].enabled = config.rules[idx].enabled === false;
        await saveConfig(config);
        renderAll();
        showToast('Zmieniono status reguły.');
      } else if (action === 'edit') {
        loadRuleIntoForm(config.rules[idx]);
      } else if (action === 'delete') {
        config.rules.splice(idx, 1);
        await saveConfig(config);
        renderAll();
        showToast('Usunięto regułę.');
      }
    });
  });
}

function loadRuleIntoForm(rule) {
  if (!rule) {
    $('#rule-form-title').textContent = 'Nowa reguła Comment-to-DM';
    $('#rule-id').value = '';
    $('#rule-name').value = '';
    $('#rule-match-mode').value = 'contains';
    $('#rule-keywords').value = '';
    $('#rule-cooldown').value = '15';
    $('#rule-public-replies').value = 'Cześć {{username}}! Wysłaliśmy szczegóły w wiadomości prywatnej!';
    $('#rule-dm-message').value = 'Hej {{username}}! 👋 Dzięki za słowo "{{keyword}}". Kliknij poniżej, aby przejść na WhatsApp:';
    $('#rule-wa-cta').value = 'Cześć! Jestem {{username}}, komentowałem "{{keyword}}".';
    return;
  }

  $('#rule-form-title').textContent = `Edycja: ${rule.name}`;
  $('#rule-id').value = rule.id;
  $('#rule-name').value = rule.name || '';
  $('#rule-match-mode').value = rule.matchMode || 'contains';
  $('#rule-keywords').value = (rule.keywords || []).join(', ');
  $('#rule-cooldown').value = String(rule.cooldownMinutes ?? 15);
  $('#rule-public-replies').value = (rule.publicReplies || []).join('\n');
  $('#rule-dm-message').value = rule.dmMessage || '';
  $('#rule-wa-cta').value = rule.whatsappCtaText || '';
}

async function handleRuleFormSubmit(e) {
  e.preventDefault();
  const existingId = $('#rule-id').value.trim();
  const name = $('#rule-name').value.trim();
  const keywords = $('#rule-keywords')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const publicReplies = $('#rule-public-replies')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!name || keywords.length === 0) {
    showToast('Podaj nazwę i przynajmniej jedno słowo kluczowe.');
    return;
  }

  const existing = config.rules.find((r) => r.id === existingId);
  const updated = {
    ...(existing || {}),
    id: existingId || `rule-${Date.now().toString(36)}`,
    name,
    enabled: existing ? existing.enabled !== false : true,
    channels: existing?.channels || ['instagram', 'facebook', 'whatsapp', 'github'],
    keywords,
    matchMode: $('#rule-match-mode').value,
    ignoreDiacritics: true,
    cooldownMinutes: Math.max(0, Number($('#rule-cooldown').value || 0)),
    publicReplies: publicReplies.length ? publicReplies : ['Dzięki {{username}}! Sprawdź DM.'],
    dmMessage: $('#rule-dm-message').value.trim(),
    whatsappCtaText: $('#rule-wa-cta').value.trim(),
    quickReplies: existing?.quickReplies || [
      {
        label: '💬 Przejdź na WhatsApp',
        reply: 'Kliknij przycisk poniżej — przeniesie Cię prosto na nasz czat WhatsApp!',
        openWhatsApp: true,
        whatsappText: $('#rule-wa-cta').value.trim() || 'Cześć! Piszę z komentarza ({{username}}).',
        leadTag: 'whatsapp-handoff',
      },
      {
        label: '📧 Zostawię kontakt w DM',
        reply: 'Jasne! Wpisz swój e-mail lub numer telefonu poniżej.',
        captureLead: true,
        leadTag: 'dm-contact',
      },
    ],
  };

  if (existing) {
    const idx = config.rules.findIndex((r) => r.id === existingId);
    config.rules[idx] = updated;
  } else {
    config.rules.push(updated);
  }

  await saveConfig(config);
  loadRuleIntoForm(updated);
  renderAll();
  showToast('Zapisano regułę!');
}

/* ==================== TAB 4: LEADS & WEBHOOK ==================== */
function renderLeads() {
  const total = leads.length;
  const qualified = leads.filter((l) => l.email || l.phone || l.status === 'Zakwalifikowany').length;
  const waCount = leads.filter((l) => l.status === 'Przekierowany na WhatsApp').length;

  $('#stat-total-leads').textContent = String(total);
  $('#stat-qualified-leads').textContent = String(qualified);
  $('#stat-wa-leads').textContent = String(waCount);

  const tbody = $('#leads-tbody');
  if (leads.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">Brak zapisanych leadów. Przetestuj komentarz w zakładce <strong>Symulator</strong>.</td></tr>`;
    return;
  }

  const statuses = ['Nowy', 'Zakwalifikowany', 'Przekierowany na WhatsApp', 'Zamknięty'];

  tbody.innerHTML = leads
    .map(
      (l) => `
      <tr>
        <td style="white-space:nowrap;color:var(--text-muted);">${esc(formatDateTime(l.createdAt))}</td>
        <td><strong>${esc(l.username)}</strong></td>
        <td>
          <span class="pill blue" style="padding:2px 7px;font-size:11px;">${esc(l.channel)}</span>
          <div style="font-size:12px;margin-top:4px;">${esc(l.ruleName || l.tag)} (<code>${esc(l.keyword)}</code>)</div>
        </td>
        <td>${esc(l.comment)}</td>
        <td>${esc([l.email, l.phone].filter(Boolean).join(' / ') || '—')}</td>
        <td>
          <select class="lead-status-select" data-id="${esc(l.id)}" style="padding:5px 8px;font-size:12px;">
            ${statuses.map((s) => `<option value="${esc(s)}" ${l.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </td>
        <td style="white-space:nowrap;">
          ${l.whatsappUrl ? `<a class="btn btn-sm btn-primary" href="${esc(l.whatsappUrl)}" target="_blank" rel="noopener noreferrer">WA ↗</a>` : ''}
          <button class="btn btn-sm btn-danger lead-delete-btn" data-id="${esc(l.id)}">×</button>
        </td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('.lead-status-select').forEach((sel) => {
    sel.addEventListener('change', () => updateLeadStatus(sel.dataset.id, sel.value));
  });

  tbody.querySelectorAll('.lead-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      leads = leads.filter((l) => l.id !== btn.dataset.id);
      await saveLeads(leads);
      renderHeader();
      renderLeads();
    });
  });
}

async function updateLeadStatus(leadId, status) {
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return;
  lead.status = status;
  await saveLeads(leads);
  renderLeads();
}

function populateWebhookForm() {
  $('#wh-url').value = config.webhook?.url || '';
  $('#wh-format').value = config.webhook?.format || 'generic';
  $('#wh-enabled').checked = Boolean(config.webhook?.enabled);
}

/* ==================== RENDER ALL & INIT ==================== */
function renderAll() {
  renderHeader();
  renderSimQuickKeywords();
  renderComments();
  renderDmMessages();
  renderLogs();
  renderRulesList();
  renderLeads();
}

function bindEvents() {
  // Simulator
  $('#sim-comment-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleSimCommentSubmit();
  });

  $('#sim-dm-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleSimDmReply();
  });

  $('#sim-reset-cooldown').addEventListener('click', () => {
    cooldownState = {};
    simComments = [];
    simDmHistory = [];
    activeSimLeadId = null;
    $('#sim-active-user').textContent = 'Oczekiwanie na komentarz';
    addLog('Wyczyszczono cooldown anty-spam oraz historię symulatora.');
    renderComments();
    renderDmMessages();
  });

  // WhatsApp & ServiceApp Studio live preview
  [
    '#wa-phone',
    '#wa-brand-name',
    '#wa-campaign',
    '#wa-position',
    '#wa-message',
    '#wa-greeting',
    '#wa-btn-label',
    '#wa-app-web',
    '#wa-app-android',
    '#wa-app-ios',
  ].forEach((sel) => {
    $(sel).addEventListener('input', refreshWhatsAppOutputs);
    $(sel).addEventListener('change', refreshWhatsAppOutputs);
  });

  $$('#channel-links-bar button[data-copy-channel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ch = btn.dataset.copyChannel;
      const url = buildChannelLandingUrl(ch, getWhatsAppDraft());
      copyText(url, `Skopiowano link pobrania ServiceApp dla kanału: ${ch.toUpperCase()}!`);
    });
  });

  $('#btn-save-wa').addEventListener('click', async () => {
    const draft = getWhatsAppDraft();
    config.brand = {
      ...(config.brand || {}),
      name: draft.brandName,
      avatarText: draft.brandName
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || 'SA',
    };
    config.appLinks = {
      web: draft.appWeb,
      android: draft.appAndroid,
      ios: draft.appIos,
    };
    config.whatsapp = {
      ...(config.whatsapp || {}),
      phone: draft.phone,
      defaultCampaign: draft.campaign,
      defaultMessage: draft.message,
      greetingBubble: draft.greeting,
      buttonLabel: draft.buttonLabel,
      widgetPosition: draft.position,
    };
    await saveConfig(config);
    renderHeader();
    refreshWhatsAppOutputs();
    showToast('Zapisano ustawienia ServiceApp & WhatsApp!');
  });

  $('#btn-copy-wa-url').addEventListener('click', () => {
    copyText($('#wa-generated-url').textContent, 'Skopiowano link Click-to-WhatsApp!');
  });

  $('#btn-copy-widget').addEventListener('click', () => {
    copyText($('#wa-widget-code').textContent, 'Skopiowano kod HTML widgetu!');
  });

  $('#btn-download-qr-svg').addEventListener('click', () => {
    const svg = $('#wa-qr-container').innerHTML;
    if (!svg.includes('<svg')) return showToast('Brak kodu QR do pobrania.');
    downloadFile('click-to-whatsapp-qr.svg', svg, 'image/svg+xml;charset=utf-8');
  });

  $('#btn-download-qr-png').addEventListener('click', downloadQrPng);

  $('#btn-toggle-widget-preview').addEventListener('click', () => {
    widgetPreviewVisible = !widgetPreviewVisible;
    if (widgetPreviewVisible) {
      $('#live-widget-mount').innerHTML = $('#wa-widget-code').textContent;
      $('#btn-toggle-widget-preview').textContent = 'Ukryj podgląd widgetu';
      showToast('Podgląd widgetu widoczny w rogu ekranu.');
    } else {
      $('#live-widget-mount').innerHTML = '';
      $('#btn-toggle-widget-preview').textContent = 'Podgląd widgetu na żywo';
    }
  });

  // Rules
  $('#btn-new-rule').addEventListener('click', () => loadRuleIntoForm(null));
  $('#rule-editor-form').addEventListener('submit', handleRuleFormSubmit);

  const exportRules = () => {
    downloadFile('rules.json', JSON.stringify(config, null, 2));
    showToast('Pobrano rules.json — możesz wrzucić do data/rules.json na GitHubie!');
  };
  $('#btn-export-rules-top').addEventListener('click', exportRules);
  $('#btn-export-rules-tab').addEventListener('click', exportRules);

  $('#input-import-rules').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.rules)) throw new Error('Plik nie zawiera tablicy rules[]');
      config = parsed;
      await saveConfig(config);
      populateWhatsAppForm();
      populateWebhookForm();
      loadRuleIntoForm(config.rules[0] || null);
      renderAll();
      showToast('Zaimportowano konfigurację JSON!');
    } catch (err) {
      showToast(`Błąd importu: ${err.message}`);
    }
    e.target.value = '';
  });

  $('#btn-reset-defaults').addEventListener('click', async () => {
    config = await resetConfigToDefault();
    populateWhatsAppForm();
    populateWebhookForm();
    loadRuleIntoForm(config.rules[0] || null);
    renderAll();
    showToast('Przywrócono domyślne reguły z data/rules.json.');
  });

  // Leads & Webhook
  $('#btn-export-csv').addEventListener('click', () => {
    if (leads.length === 0) return showToast('Brak leadów do eksportu.');
    downloadFile('leady-social-bot.csv', leadsToCsv(leads), 'text/csv;charset=utf-8');
    showToast('Wyeksportowano plik CSV (gotowy pod Excel).');
  });

  $('#btn-export-leads-json').addEventListener('click', () => {
    downloadFile('leady-social-bot.json', JSON.stringify(leads, null, 2));
  });

  $('#btn-clear-leads').addEventListener('click', async () => {
    leads = [];
    await saveLeads(leads);
    renderHeader();
    renderLeads();
    showToast('Wyczyszczono listę leadów.');
  });

  $('#btn-save-wh').addEventListener('click', async () => {
    config.webhook = {
      url: $('#wh-url').value.trim(),
      format: $('#wh-format').value,
      enabled: $('#wh-enabled').checked,
    };
    await saveConfig(config);
    showToast('Zapisano konfigurację webhooka.');
  });

  $('#btn-test-wh').addEventListener('click', async () => {
    const wh = {
      url: $('#wh-url').value.trim(),
      format: $('#wh-format').value,
      enabled: true,
    };
    if (!wh.url) return showToast('Wpisz najpierw URL webhooka.');
    const sampleLead = {
      id: 'lead_test',
      createdAt: new Date().toISOString(),
      username: '@testowy_klient',
      channel: 'instagram',
      ruleName: 'Test Webhooka',
      keyword: 'cennik',
      comment: 'Poproszę CENNIK!',
      status: 'Nowy',
      email: 'klient@firma.pl',
      phone: '48500600700',
    };
    const res = await dispatchWebhook(wh, buildOutboundWebhookPayload(sampleLead, wh.format));
    if (res.sent) showToast(`Test wysłany! Status HTTP: ${res.status}`);
    else showToast(res.error || 'Nie udało się wysłać webhooka.');
  });
}

async function init() {
  setupTabs();
  const hasServer = await detectServer();
  $('#runtime-mode-pill').innerHTML = hasServer
    ? '<span class="dot"></span>Tryb: Lokalny Serwer Node.js'
    : '<span class="dot"></span>Tryb: GitHub Pages (Static)';

  try {
    config = await loadConfig();
  } catch {
    config = { brand: { name: 'ServiceApp', handle: '@serviceapp', avatarText: 'SA' }, whatsapp: { phone: '34627193784' }, rules: [] };
  }
  leads = await loadLeads();

  populateWhatsAppForm();
  populateWebhookForm();
  loadRuleIntoForm(config.rules?.[0] || null);
  bindEvents();
  renderAll();
  addLog('Silnik uruchomiony. Zero zależności od Facebook / Meta Developer API.');
}

init();
