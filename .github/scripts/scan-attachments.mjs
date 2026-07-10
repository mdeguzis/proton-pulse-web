#!/usr/bin/env node
/**
 * Scan issue / PR-comment attachments for malware (#228).
 *
 * Called by .github/workflows/scan-issue-attachments.yml. Reads the event
 * payload from $GITHUB_EVENT_PATH, extracts every user-attachment URL
 * from the body, HEADs and hashes any that look suspicious, then queries
 * VirusTotal by SHA256. On a hit (or on a plain executable extension from
 * a non-owner), hides the comment via GraphQL minimizeComment, applies
 * the `security-review` label, and pings the repo owner.
 *
 * Env:
 *   GH_TOKEN          - workflow-scoped token (issues:write)
 *   GITHUB_EVENT_NAME - issues | issue_comment | pull_request_review_comment
 *   GITHUB_EVENT_PATH - path to the JSON event payload (github-provided)
 *   VT_API_KEY        - optional; when unset we fall back to extension-only policy
 *   REPO_OWNER        - github.repository_owner (used for owner-exempt check)
 *   REPO_NAME         - github.event.repository.name
 *
 * Never uploads content anywhere. Only sends SHA256s to VirusTotal.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  extractAttachmentUrls,
  extensionOf,
  isSuspiciousExtension,
  summarizeVirusTotal,
} from './scan-attachments-lib.mjs';

// Cap attachment download size. Even the wapebacoko sample was 2.9 MB;
// legitimate report screenshots are <2 MB. 16 MB is a generous ceiling
// that still fits GitHub Actions memory comfortably.
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

const HIDE_CLASSIFIER = 'ABUSE'; // GraphQL minimizeComment classifier
const REVIEW_LABEL   = 'security-review';

// ----- Runtime helpers (require env / GitHub API) -----

async function ghApi(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GH ${init.method || 'GET'} ${path} -> ${res.status}: ${txt.slice(0, 400)}`);
  }
  return res.json().catch(() => ({}));
}

async function ghGraphQL(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

async function ensureLabel(owner, name, label) {
  try {
    await ghApi(`/repos/${owner}/${name}/labels/${encodeURIComponent(label)}`);
    return;
  } catch { /* fall through to create */ }
  try {
    await ghApi(`/repos/${owner}/${name}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name: label,
        color: 'b60205',
        description: 'Comment / attachment flagged by scan-issue-attachments (#228)',
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) { console.warn(`ensureLabel: ${e.message}`); }
}

async function applyLabelToIssue(owner, name, issueNumber, label) {
  await ghApi(`/repos/${owner}/${name}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [label] }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function hideCommentByNodeId(nodeId) {
  await ghGraphQL(
    `mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
       minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
         minimizedComment { isMinimized }
       }
     }`,
    { id: nodeId, classifier: HIDE_CLASSIFIER },
  );
}

async function postSummary(owner, name, issueNumber, summary) {
  await ghApi(`/repos/${owner}/${name}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: summary }),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fetchAttachmentHash(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    const size = Number(head.headers.get('content-length') || 0);
    if (size && size > MAX_DOWNLOAD_BYTES) {
      return { skipped: true, reason: `size ${size} exceeds cap` };
    }
    const full = await fetch(url, { redirect: 'follow', signal: controller.signal });
    const buf = Buffer.from(await full.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) return { skipped: true, reason: 'runtime size cap' };
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    // Sniff the file magic so a `.png` masquerading a PE gets caught too.
    // MZ header (Windows PE) is the only signature we lock down today; expand
    // to ELF / Mach-O when we see attempts in those formats.
    const magic = buf.slice(0, 2).toString('binary');
    return { sha256, size: buf.length, isPeMagic: magic === 'MZ' };
  } catch (e) {
    return { skipped: true, reason: `network: ${e.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupVirusTotal(sha256) {
  const key = process.env.VT_API_KEY;
  if (!key) return { unavailable: true };
  try {
    const res = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { 'x-apikey': key },
    });
    if (res.status === 404) return { known: false };
    if (!res.ok) return { unavailable: true, reason: `HTTP ${res.status}` };
    return summarizeVirusTotal(await res.json());
  } catch (e) {
    return { unavailable: true, reason: e.message };
  }
}

// ----- Event routing -----

async function extractContext() {
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const repo = payload.repository;
  const author = payload.sender?.login;
  let body = '';
  let issueNumber = 0;
  let commentNodeId = null;

  if (eventName === 'issues') {
    body = payload.issue?.body || '';
    issueNumber = payload.issue?.number;
  } else if (eventName === 'issue_comment') {
    body = payload.comment?.body || '';
    issueNumber = payload.issue?.number;
    commentNodeId = payload.comment?.node_id;
  } else if (eventName === 'pull_request_review_comment') {
    body = payload.comment?.body || '';
    issueNumber = payload.pull_request?.number;
    commentNodeId = payload.comment?.node_id;
  }

  return {
    eventName, body, author, issueNumber, commentNodeId,
    owner: repo?.owner?.login,
    name: repo?.name,
  };
}

async function main() {
  const ctx = await extractContext();
  if (!ctx.issueNumber || !ctx.body) {
    console.log('scan-attachments: no body / issue context, nothing to do');
    return;
  }

  const urls = extractAttachmentUrls(ctx.body);
  if (urls.length === 0) {
    console.log('scan-attachments: no attachment URLs in body');
    return;
  }

  console.log(`scan-attachments: found ${urls.length} attachment(s) source=body author=${ctx.author}`);

  const findings = [];
  for (const url of urls) {
    const ext = extensionOf(url);
    const suspiciousExt = isSuspiciousExtension(ext);
    let hash = null;
    let vt = null;
    let peMagic = false;

    // Hash + VT lookup even for benign-extension files if VT is available.
    // A masqueraded .png that carries an MZ header will still get flagged.
    const meta = await fetchAttachmentHash(url);
    if (!meta.skipped) {
      hash = meta.sha256;
      peMagic = meta.isPeMagic;
      vt = await lookupVirusTotal(meta.sha256);
    }

    const flagged =
      suspiciousExt ||
      peMagic ||
      (vt && vt.known && vt.malicious > 0);
    findings.push({ url, ext, suspiciousExt, hash, peMagic, vt, flagged });
  }

  const flagged = findings.filter((f) => f.flagged);
  if (flagged.length === 0) {
    console.log('scan-attachments: no findings flagged');
    return;
  }

  // Hide the offending comment (issue_comment / PR review comment only) and
  // label the parent issue. Owner's own posts are already exempt via the
  // workflow `if:` -- this is a belt-and-braces check.
  if (ctx.commentNodeId && ctx.author !== ctx.owner) {
    try { await hideCommentByNodeId(ctx.commentNodeId); }
    catch (e) { console.warn(`hide failed: ${e.message}`); }
  }

  await ensureLabel(ctx.owner, ctx.name, REVIEW_LABEL);
  try { await applyLabelToIssue(ctx.owner, ctx.name, ctx.issueNumber, REVIEW_LABEL); }
  catch (e) { console.warn(`label failed: ${e.message}`); }

  const lines = flagged.map((f) => {
    const bits = [];
    if (f.suspiciousExt) bits.push(`suspicious ext .${f.ext}`);
    if (f.peMagic) bits.push('Windows PE header');
    if (f.vt?.known && f.vt.malicious > 0) {
      bits.push(`VirusTotal flagged (${f.vt.malicious}/${f.vt.engines} engines)`);
    } else if (f.vt?.unavailable) {
      bits.push('VirusTotal unavailable');
    }
    return `- ${f.url} (${bits.join(', ')})${f.hash ? ` \`sha256:${f.hash}\`` : ''}`;
  }).join('\n');

  const summary = [
    `Attachment scanner flagged this post -- hidden pending review.`,
    ``,
    `Author: @${ctx.author}`,
    `Event: ${ctx.eventName}`,
    `Findings:`,
    lines,
    ``,
    `If this is a false positive, unhide via the comment menu and remove the` +
    ` \`${REVIEW_LABEL}\` label. See \`Security-Guardrails\` in the wiki for` +
    ` the policy and how to expand the allowlist.`,
    ``,
    `cc @${ctx.owner}`,
  ].join('\n');

  await postSummary(ctx.owner, ctx.name, ctx.issueNumber, summary);
  console.log(`scan-attachments: hid comment + labeled + pinged @${ctx.owner} findings=${flagged.length} source=scan-issue-attachments`);
}

// Only run when the script is invoked directly (skip during unit tests).
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
