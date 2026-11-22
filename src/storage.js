/**
 * Persistence layer supporting:
 * 1. GitHub Pages / static hosting (loads defaults from ./data/rules.json, saves edits in localStorage)
 * 2. Optional local Node.js server (auto-detects /api/health and syncs to data/rules.json & data/leads.json)
 */

const CONFIG_KEY = 'social_bot_github_config_v1';
const LEADS_KEY = 'social_bot_github_leads_v1';

let serverAvailable = null;

export async function detectServer() {
  if (serverAvailable !== null) return serverAvailable;
  if (typeof window === 'undefined' || window.location.protocol === 'file:') {
    serverAvailable = false;
    return false;
  }
  try {
    const res = await fetch('./api/health', { cache: 'no-store' });
    serverAvailable = res.ok;
  } catch {
    serverAvailable = false;
  }
  return serverAvailable;
}

export async function loadDefaultConfig() {
  const res = await fetch('./data/rules.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Nie udało się wczytać data/rules.json');
  return res.json();
}

export async function loadConfig() {
  const hasServer = await detectServer();
  if (hasServer) {
    try {
      const res = await fetch('./api/config', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch {
      // fallback to localStorage
    }
  }

  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // ignore storage errors
  }

  return loadDefaultConfig();
}

export async function saveConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore storage quota errors
  }

  const hasServer = await detectServer();
  if (hasServer) {
    await fetch('./api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }).catch(() => {});
  }
}

export async function resetConfigToDefault() {
  localStorage.removeItem(CONFIG_KEY);
  const def = await loadDefaultConfig();
  await saveConfig(def);
  return def;
}

export async function loadLeads() {
  const hasServer = await detectServer();
  if (hasServer) {
    try {
      const res = await fetch('./api/leads', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch {
      // fallback
    }
  }

  try {
    const saved = localStorage.getItem(LEADS_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export async function saveLeads(leads) {
  try {
    localStorage.setItem(LEADS_KEY, JSON.stringify(leads));
  } catch {
    // ignore
  }

  const hasServer = await detectServer();
  if (hasServer) {
    await fetch('./api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(leads),
    }).catch(() => {});
  }
}

export async function dispatchWebhook(webhookConfig, payload) {
  if (!webhookConfig?.enabled || !webhookConfig?.url) {
    return { sent: false, reason: 'disabled' };
  }

  const hasServer = await detectServer();
  if (hasServer) {
    const res = await fetch('./api/webhook-relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookConfig.url, payload }),
    });
    const data = await res.json().catch(() => ({}));
    return { sent: res.ok, status: data.status || res.status, error: data.error };
  }

  // Static GitHub Pages mode: send directly from browser (works for CORS-enabled webhooks like n8n/Make/Discord)
  try {
    const res = await fetch(webhookConfig.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return {
      sent: false,
      error: `Błąd wysyłki z przeglądarki (możliwy CORS). Uruchom lokalnie "npm start" lub włącz CORS na webhooku. Szczegóły: ${err.message}`,
    };
  }
}
