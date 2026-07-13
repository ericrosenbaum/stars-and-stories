/**
 * Studio: a local web GUI for the add-story flow.
 *   npm run studio            then open the printed URL (or scan the QR code
 *                             from a phone on the same wifi)
 *
 * Upload a voice memo -> watch it transcribe -> review the 3 header-image
 * candidates -> pick one / request a new batch / skip -> publish (rebuild the
 * site bundle, git commit, git push).
 *
 * Design notes:
 * - No framework: the browser sends the audio File as a raw request body
 *   (filename/date in query params), so there is no multipart to parse.
 * - One job at a time (`currentJob`); busy requests get 409. This also serves
 *   as the lock around buildSite()/ffmpeg/sharp.
 * - Durable state is the filesystem, exactly as with the CLIs: pending
 *   candidate batches are whatever the per-story candidates/ dirs contain, so
 *   studio, CLI, and crashed runs all resume identically.
 * - SSE (/api/events) only signals "state changed"; clients re-fetch
 *   /api/state, which is the single source of truth.
 * - Env: PORT (default 4321), STUDIO_TOKEN (optional shared secret; off by
 *   default — anyone on the LAN can use the studio otherwise).
 */
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import qrcode from 'qrcode-terminal';
import { ROOT, TOOLS_DIR, CONTENT_STORIES_DIR } from './lib/paths.ts';
import { addStory, checkDuplicate, DuplicateAudioError } from './lib/add-pipeline.ts';
import {
  generateHeaderCandidates,
  selectHeaderCandidate,
  discardHeaderCandidates,
  type CandidateItem,
} from './lib/candidates.ts';
import { buildSite } from './build-site.ts';
import type { StoryRecord } from './lib/types.ts';

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 4321);
const TOKEN = process.env.STUDIO_TOKEN || '';
const INDEX_HTML = path.join(TOOLS_DIR, 'studio', 'index.html');

// ---------------------------------------------------------------------------
// Job runner: a single in-memory slot. The finished job sticks around until
// the next one starts so clients can read its result/error.
// ---------------------------------------------------------------------------

type JobKind = 'add' | 'regen' | 'select' | 'publish' | 'push';

interface Job {
  id: string;
  kind: JobKind;
  slug?: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  log: { t: number; msg: string }[];
  error?: string;
  result?: unknown;
  startedAt: number;
}

let currentJob: Job | null = null;

function jobLog(job: Job, msg: string): void {
  job.log.push({ t: Date.now(), msg });
  console.log(`[${job.kind}] ${msg}`);
  broadcast();
}

function startJob(kind: JobKind, slug: string | undefined, fn: (job: Job) => Promise<unknown>): Job | null {
  if (currentJob?.status === 'running') return null;
  const job: Job = {
    id: crypto.randomUUID(),
    kind,
    slug,
    status: 'running',
    stage: 'starting',
    log: [],
    startedAt: Date.now(),
  };
  currentJob = job;
  broadcast();
  void (async () => {
    try {
      job.result = await fn(job);
      job.status = 'done';
      job.stage = 'done';
    } catch (e: any) {
      job.status = 'error';
      job.error = e?.message || String(e);
      console.error(`[${job.kind}] failed: ${job.error}`);
    }
    broadcast();
  })();
  return job;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const sseClients = new Set<http.ServerResponse>();

function broadcast(): void {
  for (const res of sseClients) res.write('event: state\ndata: {}\n\n');
}

setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25000).unref();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PendingReview {
  slug: string;
  title: string;
  summary: string;
  createdAt: string;
  feedback?: string;
  items: CandidateItem[];
  hasCurrentHeader: boolean;
}

function safeSlug(slug: unknown): string | null {
  return typeof slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..') ? slug : null;
}

function readStory(slug: string): StoryRecord | null {
  const p = path.join(CONTENT_STORIES_DIR, slug, 'story.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function scanPending(): PendingReview[] {
  if (!fs.existsSync(CONTENT_STORIES_DIR)) return [];
  const out: PendingReview[] = [];
  for (const slug of fs.readdirSync(CONTENT_STORIES_DIR)) {
    const jsonPath = path.join(CONTENT_STORIES_DIR, slug, 'candidates', 'candidates.json');
    if (!fs.existsSync(jsonPath)) continue;
    const story = readStory(slug);
    if (!story) continue;
    try {
      const batch = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      out.push({
        slug,
        title: story.title,
        summary: story.summary,
        createdAt: batch.createdAt,
        feedback: batch.feedback,
        items: batch.items ?? [],
        hasCurrentHeader: fs.existsSync(path.join(CONTENT_STORIES_DIR, slug, 'source.png')),
      });
    } catch {
      /* unreadable batch — ignore */
    }
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

async function git(args: string[], job?: Job): Promise<string> {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    if (job) {
      const text = `${stdout}${stderr}`.trim();
      if (text) jobLog(job, text);
    }
    return stdout;
  } catch (e: any) {
    const detail = `${e?.stdout || ''}${e?.stderr || ''}`.trim();
    throw new Error(`git ${args[0]} failed${detail ? `:\n${detail}` : `: ${e?.message || e}`}`);
  }
}

let pagesUrl: string | null | undefined; // computed once; null = not a github remote

async function repoInfo(): Promise<{ branch: string; dirty: boolean; pagesUrl: string | null }> {
  try {
    if (pagesUrl === undefined) {
      const remote = (await git(['remote', 'get-url', 'origin']).catch(() => '')).trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      pagesUrl = m ? `https://${m[1]}.github.io/${m[2]}/` : null;
    }
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const status = await git(['status', '--porcelain', '--', 'content', 'site/public']);
    return { branch, dirty: status.trim().length > 0, pagesUrl };
  } catch {
    return { branch: 'unknown', dirty: false, pagesUrl: null };
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function sendBusy(res: http.ServerResponse): void {
  sendJson(res, 409, { error: 'Another job is already running. Wait for it to finish.', code: 'busy' });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true;
  return req.headers['x-studio-token'] === TOKEN || url.searchParams.get('token') === TOKEN;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (currentJob?.status === 'running') {
    sendBusy(res);
    req.destroy();
    return;
  }
  const filename = (url.searchParams.get('filename') || '').trim() || 'upload.m4a';
  const date = url.searchParams.get('date') || undefined;
  const lastModifiedRaw = Number(url.searchParams.get('lastModified'));
  const fallbackMtime = Number.isFinite(lastModifiedRaw) && lastModifiedRaw > 0 ? lastModifiedRaw : undefined;

  const tmpPath = path.join(os.tmpdir(), `studio-upload-${crypto.randomUUID()}.m4a`);
  try {
    await pipeline(req, fs.createWriteStream(tmpPath));
    if (!fs.statSync(tmpPath).size) throw new Error('Empty upload');
  } catch (e: any) {
    fs.rmSync(tmpPath, { force: true });
    sendJson(res, 400, { error: `Upload failed: ${e?.message || e}` });
    return;
  }

  // Reject duplicates now, before any Gemini spend.
  try {
    checkDuplicate(tmpPath, filename);
  } catch (e: any) {
    fs.rmSync(tmpPath, { force: true });
    if (e instanceof DuplicateAudioError) {
      sendJson(res, 409, { error: e.message, code: 'duplicate', slug: e.slug });
      return;
    }
    sendJson(res, 500, { error: e?.message || String(e) });
    return;
  }

  const job = startJob('add', undefined, async (job) => {
    try {
      const result = await addStory(tmpPath, {
        sourceFilename: filename,
        date,
        fallbackMtime,
        build: false, // deferred to publish
        onProgress: (stage, msg) => {
          job.stage = stage;
          jobLog(job, msg);
        },
      });
      job.slug = result.slug;
      if (result.candidatesError) {
        jobLog(job, `Candidate generation failed (${result.candidatesError}). The story is saved — you can generate a new batch from the review list.`);
      }
      return {
        slug: result.slug,
        title: result.record.title,
        summary: result.record.summary,
        candidatesError: result.candidatesError ?? null,
      };
    } finally {
      fs.rmSync(tmpPath, { force: true });
    }
  });
  if (!job) {
    fs.rmSync(tmpPath, { force: true });
    sendBusy(res);
    return;
  }
  sendJson(res, 202, { jobId: job.id });
}

function handleRegen(res: http.ServerResponse, body: any): void {
  const slug = safeSlug(body.slug);
  const story = slug ? readStory(slug) : null;
  if (!slug || !story) {
    sendJson(res, 404, { error: `No story found for slug "${body.slug}"` });
    return;
  }
  const feedback = typeof body.feedback === 'string' && body.feedback.trim() ? body.feedback.trim() : undefined;
  const exactPrompt = typeof body.exactPrompt === 'string' && body.exactPrompt.trim() ? body.exactPrompt.trim() : undefined;
  const job = startJob('regen', slug, async (job) => {
    job.stage = 'candidates';
    jobLog(job, `Generating a new candidate batch for "${story.title}"${feedback ? ' (with your feedback)' : ''}...`);
    await generateHeaderCandidates(slug, story, { feedback, exactPrompt });
    return { slug, title: story.title };
  });
  job ? sendJson(res, 202, { jobId: job.id }) : sendBusy(res);
}

function handleSelect(res: http.ServerResponse, body: any): void {
  const slug = safeSlug(body.slug);
  const n = Number(body.n);
  if (!slug || !readStory(slug)) {
    sendJson(res, 404, { error: `No story found for slug "${body.slug}"` });
    return;
  }
  if (!Number.isInteger(n) || n < 1) {
    sendJson(res, 400, { error: `Invalid candidate number "${body.n}"` });
    return;
  }
  const job = startJob('select', slug, async (job) => {
    job.stage = 'select';
    jobLog(job, `Selecting candidate ${n} as the header for ${slug}...`);
    await selectHeaderCandidate(slug, n); // site data refresh happens at publish
    jobLog(job, 'Header updated.');
    return { slug, n };
  });
  job ? sendJson(res, 202, { jobId: job.id }) : sendBusy(res);
}

function handleSkip(res: http.ServerResponse, body: any): void {
  const slug = safeSlug(body.slug);
  if (!slug) {
    sendJson(res, 400, { error: 'Missing slug' });
    return;
  }
  if (currentJob?.status === 'running') {
    sendBusy(res);
    return;
  }
  discardHeaderCandidates(slug);
  broadcast();
  sendJson(res, 200, { slug });
}

async function handlePublishPreview(res: http.ServerResponse): Promise<void> {
  const status = await git(['status', '--porcelain', '--', 'content', 'site/public']);
  const files = status
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
  // New stories drive the suggested commit message. An untracked story shows
  // up as the collapsed directory (`?? content/stories/<slug>/`) or, once
  // partially tracked, as its story.json.
  const newSlugs = [
    ...new Set(
      files
        .filter((f) => f.status === '??' || f.status.startsWith('A'))
        .map((f) => f.path.match(/^content\/stories\/([^/]+)\/(?:$|story\.json$)/)?.[1])
        .filter((s): s is string => !!s),
    ),
  ];
  let suggestedMessage = 'Update stories';
  if (newSlugs.length === 1) {
    const story = readStory(newSlugs[0]);
    suggestedMessage = story ? `Add story: "${story.title}"` : `Add story ${newSlugs[0]}`;
  } else if (newSlugs.length > 1) {
    suggestedMessage = `Add ${newSlugs.length} stories`;
  }
  sendJson(res, 200, {
    files,
    suggestedMessage,
    note: 'The site bundle is rebuilt during publish, so derived data/media files may be added to this list.',
  });
}

function handlePublish(res: http.ServerResponse, body: any): void {
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : 'Update stories';
  const job = startJob('publish', undefined, async (job) => {
    job.stage = 'build';
    jobLog(job, 'Rebuilding site bundle...');
    await buildSite();
    job.stage = 'commit';
    jobLog(job, 'Staging changes...');
    await git(['add', 'content', 'site/public/data', 'site/public/media'], job);
    const staged = (await git(['diff', '--cached', '--name-only'])).trim();
    if (!staged) throw new Error('Nothing to publish — no changes in content/ or site/public/.');
    jobLog(job, `Committing ${staged.split('\n').length} file(s)...`);
    await git(['commit', '-m', message], job);
    const sha = (await git(['rev-parse', 'HEAD'])).trim();
    job.stage = 'push';
    jobLog(job, 'Pushing...');
    try {
      await git(['push'], job);
    } catch (e: any) {
      // The commit exists; surface the push failure with a retry path.
      throw new Error(`Committed ${sha.slice(0, 7)} but push failed. Use "Retry push".\n${e?.message || e}`);
    }
    jobLog(job, `Published ${sha.slice(0, 7)}.`);
    return { sha, files: staged.split('\n') };
  });
  job ? sendJson(res, 202, { jobId: job.id }) : sendBusy(res);
}

function handleRetryPush(res: http.ServerResponse): void {
  const job = startJob('push', undefined, async (job) => {
    job.stage = 'push';
    jobLog(job, 'Pushing...');
    await git(['push'], job);
    const sha = (await git(['rev-parse', 'HEAD'])).trim();
    jobLog(job, `Published ${sha.slice(0, 7)}.`);
    return { sha };
  });
  job ? sendJson(res, 202, { jobId: job.id }) : sendBusy(res);
}

function handleMedia(res: http.ServerResponse, slugRaw: string, rest: string[]): void {
  const slug = safeSlug(slugRaw);
  if (!slug) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (rest[0] === 'current' && rest.length === 1) {
    serveFile(res, path.join(CONTENT_STORIES_DIR, slug, 'source.png'), 'image/png');
    return;
  }
  if (rest[0] === 'candidate' && rest.length === 2) {
    // Validate the filename against the batch manifest — no path traversal.
    const jsonPath = path.join(CONTENT_STORIES_DIR, slug, 'candidates', 'candidates.json');
    if (fs.existsSync(jsonPath)) {
      const { items } = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { items: CandidateItem[] };
      const item = items.find((it) => it.file === rest[1]);
      if (item) {
        serveFile(res, path.join(CONTENT_STORIES_DIR, slug, 'candidates', item.file), 'image/png');
        return;
      }
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  try {
    if (!authorized(req, url)) {
      sendJson(res, 401, { error: 'Missing or wrong token' });
      return;
    }

    if (req.method === 'GET' && p === '/') {
      serveFile(res, INDEX_HTML, 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && p === '/api/state') {
      sendJson(res, 200, { job: currentJob, pending: scanPending(), repo: await repoInfo() });
      return;
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\nretry: 2000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    const media = p.match(/^\/api\/media\/([^/]+)\/(.+)$/);
    if (req.method === 'GET' && media) {
      handleMedia(res, decodeURIComponent(media[1]), media[2].split('/').map(decodeURIComponent));
      return;
    }

    if (req.method === 'GET' && p === '/api/publish/preview') {
      await handlePublishPreview(res);
      return;
    }

    if (req.method === 'POST' && p === '/api/upload') {
      await handleUpload(req, res, url);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (p === '/api/regen') return handleRegen(res, body);
      if (p === '/api/select') return handleSelect(res, body);
      if (p === '/api/skip') return handleSkip(res, body);
      if (p === '/api/publish') return handlePublish(res, body);
      if (p === '/api/publish/push') return handleRetryPush(res);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e: any) {
    console.error(`[studio] ${req.method} ${p} failed:`, e);
    if (!res.headersSent) sendJson(res, 500, { error: e?.message || String(e) });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const tokenSuffix = TOKEN ? `?token=${TOKEN}` : '';
  const urls = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}/${tokenSuffix}`);
  console.log('\nStars & Stories studio is running:\n');
  console.log(`  Mac:    http://localhost:${PORT}/${tokenSuffix}`);
  for (const u of urls) console.log(`  Phone:  ${u}   (same wifi)`);
  if (!TOKEN) console.log('\n  Note: anyone on your wifi can reach this. Set STUDIO_TOKEN in tools/.env to require a token.');
  if (urls[0]) {
    console.log('\nScan from your phone:\n');
    qrcode.generate(urls[0], { small: true });
  }
  execFileP('ffmpeg', ['-version']).catch(() => {
    console.warn('\nWARNING: ffmpeg not found — publish (audio encoding) will fail. Install it: brew install ffmpeg');
  });
});
