# Dead-Link-Checker

A Node.js + vanilla JS broken link checker with live crawl updates.

## Features
- Single webpage and whole website crawling modes.
- Queue-based spider crawl for internal links.
- Link extraction from `a[href]`, `img[src]`, `script[src]`, and `link[href]`.
- Live progress + live results table updates.
- Status labels for OK, redirect, timeout, and broken links.
- Pause/resume and stop controls.
- CSV export and broken-only filter.
- Crawl safety limits (max 2000 pages, duplicate avoidance, unsupported link filtering).

## Run
```bash
npm install
npm start
```

Then open `http://localhost:3000`.
