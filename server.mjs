#!/usr/bin/env node
/**
 * Optional zero-dependency local server for Social Bot Studio.
 * Serves the static files (same as GitHub Pages) AND adds local JSON persistence + webhook relay.
 *
 * Usage: node server.mjs   (or: npm start)
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const RULES_FILE = path.join(__dirname, 'data', 'rules.json');
const LEADS_FILE = path.join(__dirname, 'data', 'leads.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, mode: 'local-node-server' });
  }

  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      const raw = await fs.readFile(RULES_FILE, 'utf8');
      return sendJson(res, 200, JSON.parse(raw));
    }
    if (req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      await fs.writeFile(RULES_FILE, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/leads') {
    if (req.method === 'GET') {
      try {
        const raw = await fs.readFile(LEADS_FILE, 'utf8');
        return sendJson(res, 200, JSON.parse(raw));
      } catch {
        return sendJson(res, 200, []);
      }
    }
    if (req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req));
      if (!Array.isArray(parsed)) return sendJson(res, 400, { error: 'Expected array' });
      await fs.writeFile(LEADS_FILE, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      return sendJson(res, 200, { ok: true, count: parsed.length });
    }
  }

  if (pathname === '/api/webhook-relay' && req.method === 'POST') {
    const { url, payload } = JSON.parse(await readBody(req));
    if (!url || !/^https?:\/\//i.test(url)) {
      return sendJson(res, 400, { error: 'Invalid webhook URL' });
    }
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return sendJson(res, upstream.ok ? 200 : 502, {
        ok: upstream.ok,
        status: upstream.status,
      });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const pathname = decodeURIComponent(reqUrl.pathname);

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }

    const relPath = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.resolve(__dirname, '.' + relPath);
    if (!resolved.startsWith(__dirname + path.sep) && resolved !== __dirname) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 Social Bot Studio działa lokalnie pod adresem:`);
  console.log(`   Panel główny:          http://${HOST}:${PORT}/`);
  console.log(`   Strona WhatsApp Bio:   http://${HOST}:${PORT}/whatsapp.html\n`);
});
