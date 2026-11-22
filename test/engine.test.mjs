import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOutboundWebhookPayload,
  buildTrackedStoreUrl,
  buildWhatsAppUrl,
  extractContactInfo,
  leadsToCsv,
  matchRule,
  normalizeText,
  processComment,
  sanitizePhone,
} from '../src/engine.js';
import { generateQrMatrix, generateQrSvg } from '../src/qr.js';
import { generateWidgetSnippet } from '../src/widget-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultConfig = JSON.parse(
  await fs.readFile(path.resolve(__dirname, '../data/rules.json'), 'utf8')
);

test('normalizeText strips Polish diacritics and lowercases', () => {
  assert.equal(normalizeText('Zażółć Gęślą Jaźń'), 'zazolc gesla jazn');
  assert.equal(normalizeText('  CENNIK  '), 'cennik');
});

test('sanitizePhone formats international and 9-digit Polish numbers', () => {
  assert.equal(sanitizePhone('+34 627193784'), '34627193784');
  assert.equal(sanitizePhone('+48 500-600-700'), '48500600700');
  assert.equal(sanitizePhone('0048 500 600 700'), '48500600700');
  assert.equal(sanitizePhone('500 600 700'), '48500600700');
});

test('buildWhatsAppUrl creates valid wa.me link with interpolated text', () => {
  const url = buildWhatsAppUrl({
    phone: '500-600-700',
    text: 'Cześć {{username}}! Kampania: {{campaign}}',
    username: '@anna',
    campaign: 'ig-bio',
  });
  assert.equal(
    url,
    'https://wa.me/48500600700?text=Cze%C5%9B%C4%87%20%40anna!%20Kampania%3A%20ig-bio'
  );
});

test('matchRule supports contains, exact, startsWith, regex and diacritics', () => {
  const customRules = [
    { id: 'r1', enabled: true, keywords: ['cennik'], matchMode: 'contains' },
    { id: 'r2', enabled: true, keywords: ['start'], matchMode: 'exact' },
    { id: 'r3', enabled: true, keywords: ['^zamawiam\\s+#\\d+'], matchMode: 'regex' },
  ];

  assert.equal(matchRule('Poproszę cennik na 2026!', customRules).rule.id, 'r1');
  assert.equal(matchRule('START', customRules).rule.id, 'r2');
  assert.equal(matchRule('START teraz', customRules).matched, false);
  assert.equal(matchRule('Zamawiam #42', customRules).rule.id, 'r3');
});

test('processComment triggers ServiceApp download reply, DM, tracked store links and cooldown across IG/FB/WA', () => {
  const state = {};
  const t0 = new Date('2026-11-22T12:00:00Z').getTime();

  const res1 = processComment(
    {
      username: '@marek',
      comment: 'Hej, poproszę POBIERZ ServiceApp!',
      channel: 'instagram',
      timestamp: t0,
      variantSeed: 0,
    },
    defaultConfig,
    state
  );

  assert.equal(res1.matched, true);
  assert.equal(res1.skippedReason, null);
  assert.equal(res1.rule.id, 'serviceapp-download-pl');
  assert.ok(res1.publicReply.includes('@marek'));
  assert.ok(res1.publicReply.includes('ServiceApp'));
  assert.ok(res1.dmMessage.includes('https://serviceapp.mobi'));
  assert.ok(res1.dmMessage.includes('play.google.com'));
  assert.ok(res1.dmMessage.includes('https://apps.apple.com/ie/app/pl-serviceapp/id1253478797'));
  assert.ok(res1.whatsappUrl.startsWith('https://wa.me/34627193784?text='));
  assert.ok(res1.appLinks.android.includes('utm_source%3Dinstagram'));
  assert.equal(res1.leadCandidate.username, '@marek');

  // Same user 2 minutes later -> blocked by 15 min cooldown
  const res2 = processComment(
    {
      username: '@marek',
      comment: 'jeszcze raz pobierz',
      channel: 'instagram',
      timestamp: t0 + 2 * 60 * 1000,
    },
    defaultConfig,
    state
  );
  assert.equal(res2.matched, true);
  assert.equal(res2.skippedReason, 'cooldown_active');
  assert.ok(res2.remainingSeconds > 0);

  // WhatsApp & Facebook channels also work seamlessly
  const resWa = processComment(
    {
      username: '@kasia',
      comment: 'Chcę pobrać aplikację!',
      channel: 'whatsapp',
      timestamp: t0,
    },
    defaultConfig,
    state
  );
  assert.equal(resWa.matched, true);
  assert.equal(resWa.rule.id, 'serviceapp-download-pl');
  assert.ok(resWa.appLinks.android.includes('utm_source%3Dwhatsapp'));

  const resFb = processComment(
    {
      username: '@tomek',
      comment: 'POBIERZ',
      channel: 'facebook',
      timestamp: t0,
    },
    defaultConfig,
    state
  );
  assert.equal(resFb.matched, true);
  assert.ok(resFb.appLinks.web.includes('utm_source=facebook'));

  // Same user 20 minutes later -> allowed again
  const res3 = processComment(
    {
      username: '@marek',
      comment: 'pobierz ponownie',
      channel: 'instagram',
      timestamp: t0 + 20 * 60 * 1000,
    },
    defaultConfig,
    state
  );
  assert.equal(res3.matched, true);
  assert.equal(res3.skippedReason, null);
});

test('all North & South America languages match their dedicated ServiceApp rules without collision', () => {
  const cases = [
    ['Want to download the app!', 'serviceapp-download-en-americas'],
    ['Quiero descargar la app en México!', 'serviceapp-download-es-americas'],
    ['Busco laburo en Argentina', 'serviceapp-download-es-americas'],
    ['Busco pega en Chile', 'serviceapp-download-es-americas'],
    ['Busco camello en Colombia', 'serviceapp-download-es-americas'],
    ['Quero baixar o aplicativo no Brasil!', 'serviceapp-download-pt-br'],
    ["Je veux télécharger l'application au Québec!", 'serviceapp-download-fr-americas'],
    ['Ik wil de app downloaden in Suriname!', 'serviceapp-download-nl-americas'],
    ['Mwen vle telechaje aplikasyon an!', 'serviceapp-download-ht-haiti'],
    ['Aipota mboguejy tembiapo Paraguay-pe!', 'serviceapp-download-gn-paraguay'],
    ['APP', 'serviceapp-universal-global'],
  ];

  for (const [comment, expectedRuleId] of cases) {
    const res = processComment({ username: '@user', comment, channel: 'instagram' }, defaultConfig, {});
    assert.equal(res.matched, true, `Expected match for: ${comment}`);
    assert.equal(res.rule.id, expectedRuleId, `Wrong rule for "${comment}": got ${res.rule.id}`);
    assert.ok(res.whatsappUrl.startsWith('https://wa.me/34627193784?text='));
  }
});

test('buildTrackedStoreUrl adds Google Play referrer, App Store ct and Web UTM params', () => {
  const play = buildTrackedStoreUrl('https://play.google.com/store/apps/details?id=com.serviceapp.mobile', {
    source: 'instagram',
    campaign: 'launch',
  });
  assert.ok(play.includes('referrer=utm_source%3Dinstagram'));

  const ios = buildTrackedStoreUrl('https://apps.apple.com/pl/app/serviceapp/id12345', {
    source: 'facebook',
    campaign: 'launch',
  });
  assert.ok(ios.includes('ct=facebook_launch'));

  const web = buildTrackedStoreUrl('https://serviceapp.mobi', {
    source: 'whatsapp',
    campaign: 'launch',
  });
  assert.ok(web.includes('utm_source=whatsapp'));
});

test('extractContactInfo detects emails and phone numbers', () => {
  const info = extractContactInfo('Mój mail to jan.kowalski@firma.pl, tel +48 601-202-303');
  assert.equal(info.hasContact, true);
  assert.equal(info.email, 'jan.kowalski@firma.pl');
  assert.equal(info.phone, '48601202303');

  const empty = extractContactInfo('Dzięki, zastanowię się!');
  assert.equal(empty.hasContact, false);
});

test('leadsToCsv outputs UTF-8 BOM and properly escaped semicolon rows', () => {
  const csv = leadsToCsv([
    {
      id: 'lead_1',
      createdAt: '2026-11-22T12:00:00Z',
      username: '@ola',
      channel: 'instagram',
      ruleName: 'Cennik i oferta',
      keyword: 'cennik',
      status: 'Nowy',
      email: 'ola@test.pl',
      phone: '48500600700',
      comment: 'Poproszę; "cennik"',
      notes: '',
      whatsappUrl: 'https://wa.me/48500600700',
    },
  ]);

  assert.ok(csv.startsWith('\uFEFFID;Data;Użytkownik;'));
  assert.ok(csv.includes('"Poproszę; ""cennik"""'));
});

test('buildOutboundWebhookPayload supports generic, discord and slack formats', () => {
  const lead = { username: '@ola', channel: 'github', ruleName: 'Cennik', keyword: 'cennik', comment: 'cennik' };
  assert.equal(buildOutboundWebhookPayload(lead, 'generic').event, 'social_bot.lead_captured');
  assert.ok(Array.isArray(buildOutboundWebhookPayload(lead, 'discord').embeds));
  assert.ok(buildOutboundWebhookPayload(lead, 'slack').text.includes('@ola'));
});

test('generateQrMatrix & generateQrSvg generate valid QR matrices and SVG markup', () => {
  const url = 'https://wa.me/48500600700?text=Cze%C5%9B%C4%87%20z%20GitHuba!';
  const { version, size, matrix } = generateQrMatrix(url);

  assert.ok(version >= 1 && version <= 12);
  assert.equal(size, version * 4 + 17);
  // Top-left finder pattern border & center check
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[0][6], 1);
  assert.equal(matrix[3][3], 1);
  assert.equal(matrix[1][1], 0);
  // Top-right & bottom-left finder corners
  assert.equal(matrix[0][size - 1], 1);
  assert.equal(matrix[size - 1][0], 1);

  const svg = generateQrSvg(url);
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('<path d="M'));
  assert.ok(svg.endsWith('</svg>'));
});

test('generateWidgetSnippet outputs embeddable HTML with safe wa.me URL', () => {
  const html = generateWidgetSnippet({
    phone: '500600700',
    message: 'Cześć z {{campaign}}!',
    campaign: 'strona-glowna',
    brandName: 'Sklep <Test>',
  });
  assert.ok(html.includes('https://wa.me/48500600700?text='));
  assert.ok(html.includes('Sklep &lt;Test&gt;'));
  assert.ok(!html.includes('Sklep <Test>'));
});
