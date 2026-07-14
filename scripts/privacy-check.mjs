#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const modes = new Set(process.argv.slice(2));
if (!modes.size || [...modes].some((mode) => !['--staged', '--tracked', '--history'].includes(mode))) {
  process.stderr.write('usage: node scripts/privacy-check.mjs [--staged] [--tracked] [--history]\n');
  process.exit(2);
}

const MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024;
const findings = [];
const scannedObjects = new Set();

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function privatePathReason(file) {
  const normalized = String(file || '').replace(/^(?:staged|tracked|history):/, '').replaceAll('\\', '/');
  const base = path.posix.basename(normalized);
  if (['services.json', 'host-config.json', 'AGENTS.md'].includes(normalized) || base === 'AGENTS.md') return 'machine-local configuration';
  if (/^(?:data|tmp|screenshots|captures)(?:\/|$)/.test(normalized)) return 'private runtime directory';
  if (/^docs\/incident-[^/]+\.md$/i.test(normalized)) return 'private incident note';
  if (/(?:^|\/)\.env(?:\.|$)/.test(normalized) && normalized !== '.env.example') return 'environment file';
  if (/(?:^|\/)(?:\.codex|\.claude|\.aws|\.ssh|\.docker)(?:\/|$)/.test(normalized)) return 'agent or credential state';
  if (/(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?|secrets?\.json|tokens?\.json|auth\.json|kubeconfig|id_(?:rsa|dsa|ecdsa|ed25519))$/i.test(normalized)) return 'credential file';
  if (/\.(?:tfstate(?:\.[^/]*)?|tfvars(?:\.json)?|jks|kdbx|ovpn)$/i.test(normalized)) return 'credential or infrastructure state';
  if (/\.(?:log(?:\.[^/]*)?|pid|pem|key|p12|pfx|keystore)$/i.test(normalized)) return 'secret or runtime file type';
  if (/\.(?:pdf|docx?|xlsx?|csv|sqlite3?|db|zip|tar|tgz|gz|7z|jpg|jpeg|png|webp|heic|gif|mp4|mov)$/i.test(normalized)) return 'binary, document, archive, or capture';
  return '';
}

function allowedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  if (ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '169.254.169.254') return true;
  return (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

function inspectText(file, text) {
  const patterns = [
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/i],
    ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ['OpenAI-style secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
    ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
    ['Stripe live secret', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
    ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}\b/],
    ['credential URL', /\b(?:postgres(?:ql)?|mysql|redis|https?):\/\/[^\s/:@]+:[^\s@]+@[^\s]+/i],
    ['absolute user home path', /\/(?:home|Users)\/[A-Za-z0-9._-]+\//],
    ['EC2 instance identifier', /\bi-[0-9a-f]{8,17}\b/i],
    ['EC2 security group identifier', /\bsg-[0-9a-f]{8,17}\b/i],
    ['AWS account or resource ARN', /\barn:aws(?:-[a-z]+)?:[^\s:]+:[^\s:]*:\d{12}:/i],
    ['EC2 internal hostname', /\bip-(?:\d+-){3}\d+\.[A-Za-z0-9.-]*compute\.internal\b/i],
    ['EC2 public hostname', /\bec2-(?:\d+-){3}\d+\.[A-Za-z0-9.-]*compute\.amazonaws\.com\b/i]
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: possible ${label}`);
  }

  const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  for (const match of text.matchAll(emailPattern)) {
    const domain = match[0].split('@')[1].toLowerCase();
    if (!['example.com', 'example.org', 'example.net'].includes(domain)) {
      findings.push(`${file}: non-example email address`);
      break;
    }
  }

  const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  for (const match of text.matchAll(ipv4Pattern)) {
    if (!allowedIpv4(match[0])) {
      findings.push(`${file}: non-documentation IPv4 literal`);
      break;
    }
  }
}

function inspectBuffer(file, buffer) {
  const reason = privatePathReason(file);
  if (reason) findings.push(`${file}: ${reason}`);
  if (buffer.length > MAX_PUBLIC_FILE_BYTES) findings.push(`${file}: exceeds 2 MiB public-file limit`);
  if (buffer.includes(0)) {
    findings.push(`${file}: binary content is not allowed`);
    return;
  }
  inspectText(file, buffer.toString('utf8'));
}

function nullSeparated(value) {
  return value.split('\0').filter(Boolean);
}

if (modes.has('--staged')) {
  for (const file of nullSeparated(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']))) {
    let buffer;
    try {
      buffer = git(['show', `:${file}`], { encoding: null });
    } catch {
      continue;
    }
    inspectBuffer(`staged:${file}`, buffer);
  }
}

if (modes.has('--tracked')) {
  for (const file of nullSeparated(git(['ls-files', '-z']))) {
    try {
      inspectBuffer(`tracked:${file}`, git(['show', `:${file}`], { encoding: null }));
    } catch (error) {
      findings.push(`tracked:${file}: cannot read (${error?.code || 'error'})`);
    }
  }
}

if (modes.has('--history')) {
  const objects = git(['rev-list', '--objects', '--all']).split('\n').filter(Boolean);
  for (const line of objects) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const object = line.slice(0, separator);
    const file = line.slice(separator + 1);
    if (!object || !file || scannedObjects.has(object)) continue;
    let type;
    try {
      type = git(['cat-file', '-t', object]).trim();
    } catch {
      continue;
    }
    if (type !== 'blob') continue;
    scannedObjects.add(object);
    inspectBuffer(`history:${file}`, git(['cat-file', 'blob', object], { encoding: null }));
  }

  // Reachability is not enough for publication cleanup: amended commits and
  // deleted blobs can survive in reflogs or as loose objects and later be
  // recovered from a copied .git directory. Scan every stored commit, tag, and
  // blob so local privacy checks expose those remnants before a public push.
  const storedObjects = git([
    'cat-file',
    '--batch-all-objects',
    "--batch-check=%(objectname) %(objecttype)"
  ]).split('\n').filter(Boolean);
  for (const line of storedObjects) {
    const [object, type] = line.split(' ');
    if (!object || !['blob', 'commit', 'tag'].includes(type) || scannedObjects.has(object)) continue;
    scannedObjects.add(object);
    const buffer = git(['cat-file', type, object], { encoding: null });
    if (type === 'blob') inspectBuffer(`objects:${object}`, buffer);
    else inspectText(`objects:${object}`, buffer.toString('utf8'));
  }
}

if (findings.length) {
  process.stderr.write(`privacy check failed with ${findings.length} finding(s):\n`);
  for (const finding of [...new Set(findings)].sort()) process.stderr.write(`- ${finding}\n`);
  process.exit(1);
}

process.stdout.write(`privacy check passed (${[...modes].join(', ')})\n`);
