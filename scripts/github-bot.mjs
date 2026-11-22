#!/usr/bin/env node
/**
 * GitHub Actions Comment-to-Reply & Click-to-WhatsApp Bot.
 * Runs 100% natively on GitHub Actions using built-in GITHUB_TOKEN (zero external dependencies, zero Facebook/Meta API).
 *
 * Local dry-run example:
 *   BOT_DRY_RUN=1 COMMENT_AUTHOR=janek COMMENT_BODY="Poprosze CENNIK" node scripts/github-bot.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutboundWebhookPayload, processComment } from '../src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '../data/rules.json');

async function loadEventPayload() {
  if (process.env.GITHUB_EVENT_PATH) {
    const raw = await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8');
    const ev = JSON.parse(raw);
    const commentObj = ev.comment || ev.issue || {};
    return {
      author: commentObj.user?.login || ev.sender?.login || 'github_user',
      authorType: commentObj.user?.type || ev.sender?.type || 'User',
      body: commentObj.body || '',
      issueNumber: ev.issue?.number || ev.pull_request?.number || null,
      repo: process.env.GITHUB_REPOSITORY || ev.repository?.full_name || '',
    };
  }

  return {
    author: process.env.COMMENT_AUTHOR || 'tester',
    authorType: 'User',
    body: process.env.COMMENT_BODY || '',
    issueNumber: process.env.ISSUE_NUMBER || null,
    repo: process.env.GITHUB_REPOSITORY || 'owner/repo',
  };
}

function formatGitHubReply(result, brandName) {
  const lines = [
    result.publicReply,
    '',
    '---',
    result.dmMessage,
  ];

  if (result.whatsappUrl) {
    lines.push('');
    lines.push(`📲 **[Kliknij tutaj, aby napisać na WhatsApp (${brandName})](${result.whatsappUrl})**`);
  }

  lines.push('');
  lines.push(`<sub>🤖 Automatyczna odpowiedź bota (reguła: \`${result.rule.id}\`, słowo kluczowe: \`${result.keyword}\`)</sub>`);
  return lines.join('\n');
}

async function postGitHubComment(repo, issueNumber, body, token) {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'social-bot-github-action',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub API error (${res.status}): ${errText}`);
  }
  return res.json();
}

async function main() {
  const config = JSON.parse(await fs.readFile(RULES_PATH, 'utf8'));

  // Optional override via GitHub Repository Secret/Variable WHATSAPP_PHONE
  if (process.env.WHATSAPP_PHONE) {
    config.whatsapp = { ...(config.whatsapp || {}), phone: process.env.WHATSAPP_PHONE };
  }

  const event = await loadEventPayload();

  // Prevent infinite bot reply loops
  if (event.authorType === 'Bot' || event.author.endsWith('[bot]')) {
    console.log(`Skipping bot comment from ${event.author}.`);
    return;
  }

  if (!event.body.trim()) {
    console.log('Empty comment body — nothing to process.');
    return;
  }

  const result = processComment(
    {
      username: `@${event.author}`,
      comment: event.body,
      channel: 'github',
    },
    config,
    {}
  );

  if (!result.matched) {
    console.log(`No matching rule for comment from @${event.author}.`);
    return;
  }

  const replyBody = formatGitHubReply(result, config.brand?.name || 'WhatsApp');
  console.log(`Matched rule "${result.rule.name}" via keyword "${result.keyword}".`);

  const isDryRun = process.env.BOT_DRY_RUN === '1' || !process.env.GITHUB_TOKEN || !event.issueNumber;
  if (isDryRun) {
    console.log('\n--- DRY RUN REPLY ---\n' + replyBody + '\n---------------------\n');
  } else {
    const created = await postGitHubComment(event.repo, event.issueNumber, replyBody, process.env.GITHUB_TOKEN);
    console.log(`Posted GitHub comment: ${created.html_url}`);
  }

  // Optional outbound webhook (Discord / Slack / n8n / Make) via GitHub Secret OUTBOUND_WEBHOOK_URL
  const webhookUrl = process.env.OUTBOUND_WEBHOOK_URL || (config.webhook?.enabled ? config.webhook.url : '');
  if (webhookUrl && !isDryRun) {
    const format = process.env.OUTBOUND_WEBHOOK_FORMAT || config.webhook?.format || 'generic';
    const payload = buildOutboundWebhookPayload(result.leadCandidate, format);
    const whRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`Outbound webhook status: ${whRes.status}`);
  }
}

main().catch((err) => {
  console.error('Bot execution failed:', err);
  process.exit(1);
});
