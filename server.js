const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PAGES = 2000;
const LINK_CONCURRENCY = 15;
const PAGE_CONCURRENCY = 5;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const scans = new Map();

function emit(scan, event, payload = {}) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of scan.clients) {
    client.write(message);
  }
}

function initScan(url, mode) {
  const scan = {
    id: uuidv4(),
    url,
    mode,
    state: 'running',
    queue: [url],
    visitedPages: new Set(),
    checkedLinks: new Set(),
    results: [],
    resultIndexByUrl: new Map(),
    clients: new Set(),
    pageWorkers: 0,
    linkWorkers: 0,
    stats: {
      pagesCrawled: 0,
      urlsScanned: 0,
      ok: 0,
      broken: 0,
      redirect: 0,
      failed: 0,
      checking: 0
    }
  };
  scans.set(scan.id, scan);
  runScan(scan);
  return scan;
}

function getSourceText(el, $) {
  if (el.name === 'a') {
    return $(el).text().trim() || '(no text)';
  }
  if (el.name === 'img') {
    return $(el).attr('alt') || '(image)';
  }
  return `(${el.name})`;
}

function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('javascript:')) {
    return null;
  }
  try {
    const normalized = new URL(trimmed, baseUrl);
    normalized.hash = '';
    return normalized.toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: () => true
  });
  if (response.status >= 200 && response.status < 400 && typeof response.data === 'string') {
    return response.data;
  }
  return '';
}

async function processPage(scan, pageUrl) {
  try {
    const html = await fetchHtml(pageUrl);
    const $ = cheerio.load(html);
    const elements = $('a[href], img[src], script[src], link[href]').toArray();

    for (const el of elements) {
      const attr = el.name === 'a' || el.name === 'link' ? 'href' : 'src';
      const link = normalizeUrl($(el).attr(attr), pageUrl);
      if (!link) continue;
      addLinkForChecking(scan, link, getSourceText(el, $));

      if (scan.mode === 'whole' && el.name === 'a') {
        try {
          const current = new URL(scan.url);
          const candidate = new URL(link);
          const isInternal = current.hostname === candidate.hostname;
          if (isInternal && !scan.visitedPages.has(link) && !scan.queue.includes(link) && scan.queue.length + scan.visitedPages.size < MAX_PAGES) {
            scan.queue.push(link);
          }
        } catch {
          // ignore invalid url
        }
      }
    }
  } finally {
    scan.stats.pagesCrawled += 1;
    emitProgress(scan, pageUrl);
  }
}

function addLinkForChecking(scan, link, sourceText) {
  if (scan.checkedLinks.has(link)) return;
  scan.checkedLinks.add(link);

  const result = {
    id: uuidv4(),
    status: 'Checking',
    url: link,
    sourceText
  };
  scan.results.push(result);
  scan.resultIndexByUrl.set(link, result);
  scan.stats.urlsScanned += 1;
  scan.stats.checking += 1;
  emit(scan, 'result', result);
}

function classifyStatus(statusCode) {
  if (statusCode >= 200 && statusCode < 300) return 'OK';
  if (statusCode === 301 || statusCode === 302) return 'Redirect';
  if (statusCode === 404) return '404 Not Found';
  if (statusCode === 500) return '500 Internal Server Error';
  if (statusCode === 503) return '503 Service Unavailable';
  if (statusCode >= 400) return 'Failed';
  return 'Redirect';
}

async function checkLink(scan, link) {
  const result = scan.resultIndexByUrl.get(link);
  if (!result || scan.state === 'stopped') return;

  emitProgress(scan, link);
  try {
    const response = await axios.get(link, {
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: () => true
    });

    const label = classifyStatus(response.status);
    result.status = response.status >= 200 && response.status < 300
      ? `${response.status} OK`
      : response.status === 301 || response.status === 302
        ? `${response.status} Redirect`
        : label;

    if (response.status >= 200 && response.status < 300) scan.stats.ok += 1;
    else if (response.status === 301 || response.status === 302) scan.stats.redirect += 1;
    else {
      scan.stats.broken += 1;
      scan.stats.failed += 1;
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      result.status = 'Timeout';
    } else {
      result.status = 'Failed';
    }
    scan.stats.broken += 1;
    scan.stats.failed += 1;
  } finally {
    scan.stats.checking = Math.max(0, scan.stats.checking - 1);
    emit(scan, 'result', result);
    emitProgress(scan, link);
  }
}

function getPendingLinks(scan) {
  return scan.results.filter((r) => r.status === 'Checking').map((r) => r.url);
}

function emitProgress(scan, currentItem = '') {
  const checkedCount = scan.stats.ok + scan.stats.redirect + scan.stats.failed;
  const total = scan.stats.urlsScanned || 1;
  const percent = Math.min(100, Math.round((checkedCount / total) * 100));

  emit(scan, 'progress', {
    percent,
    checkedCount,
    total,
    currentItem,
    stats: scan.stats,
    state: scan.state
  });
}

function maybeComplete(scan) {
  if (
    scan.state === 'running' &&
    scan.queue.length === 0 &&
    scan.pageWorkers === 0 &&
    getPendingLinks(scan).length === 0 &&
    scan.linkWorkers === 0
  ) {
    scan.state = 'completed';
    emitProgress(scan);
    emit(scan, 'done', { state: scan.state, stats: scan.stats });
  }
}

function runScan(scan) {
  const timer = setInterval(async () => {
    if (scan.state === 'stopped' || scan.state === 'completed') {
      clearInterval(timer);
      return;
    }

    if (scan.state === 'paused') return;

    while (scan.pageWorkers < PAGE_CONCURRENCY && scan.queue.length > 0) {
      const nextPage = scan.queue.shift();
      if (!nextPage || scan.visitedPages.has(nextPage)) continue;
      if (scan.visitedPages.size >= MAX_PAGES) break;

      scan.visitedPages.add(nextPage);
      scan.pageWorkers += 1;
      processPage(scan, nextPage)
        .catch(() => {})
        .finally(() => {
          scan.pageWorkers -= 1;
        });

      if (scan.mode === 'single') {
        scan.queue.length = 0;
      }
    }

    const pending = getPendingLinks(scan);
    while (scan.linkWorkers < LINK_CONCURRENCY && pending.length > 0) {
      const nextLink = pending.shift();
      if (!nextLink) continue;
      scan.linkWorkers += 1;
      checkLink(scan, nextLink)
        .catch(() => {})
        .finally(() => {
          scan.linkWorkers -= 1;
        });
    }

    maybeComplete(scan);
  }, 150);
}

app.post('/api/scan/start', (req, res) => {
  const { url, mode } = req.body;
  if (!url || !['single', 'whole'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const scan = initScan(url, mode);
  return res.json({ scanId: scan.id });
});

app.post('/api/scan/:id/pause', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  scan.state = 'paused';
  emitProgress(scan);
  return res.json({ state: scan.state });
});

app.post('/api/scan/:id/resume', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  scan.state = 'running';
  emitProgress(scan);
  return res.json({ state: scan.state });
});

app.post('/api/scan/:id/stop', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  scan.state = 'stopped';
  emitProgress(scan);
  emit(scan, 'done', { state: scan.state, stats: scan.stats });
  return res.json({ state: scan.state });
});

app.get('/api/scan/:id/events', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  scan.clients.add(res);
  emitProgress(scan);

  req.on('close', () => {
    scan.clients.delete(res);
  });
});

app.get('/api/scan/:id/export.csv', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  const header = 'Status,URL,Source Link Text\n';
  const rows = scan.results.map((r) => {
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    return `${esc(r.status)},${esc(r.url)},${esc(r.sourceText)}`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="scan-${scan.id}.csv"`);
  return res.send(header + rows.join('\n'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
