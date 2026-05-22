import express from 'express';
import cron from 'node-cron';
import Database from 'better-sqlite3';

const PORT = process.env.PORT || 10000;
const DB_PATH = process.env.DB_PATH || './stockradar_news.db';
const TZ = 'Asia/Taipei';

const STOCK_NEWS_COOLDOWN_MS = 60 * 60 * 1000; // 1小時
const STOCK_NEWS_MAX = 10;
const STOCK_NEWS_KEEP_DAYS = 7;
const SECTOR_KEEP_DAYS = 30;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const app = express();
app.use(express.json());

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_news (
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  src TEXT,
  pub INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (code, link)
);

CREATE INDEX IF NOT EXISTS idx_stock_news_code_pub ON stock_news(code, pub DESC);

CREATE TABLE IF NOT EXISTS stock_refresh_state (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_refresh_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sector_news (
  title TEXT NOT NULL,
  link TEXT NOT NULL PRIMARY KEY,
  src TEXT,
  pub INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sector_news_pub ON sector_news(pub DESC);
`);

function nowMs() {
  return Date.now();
}

function twHourMinuteDay() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return {
    day: weekdayMap[obj.weekday] ?? 0,
    hour: Number(obj.hour),
    minute: Number(obj.minute),
  };
}

function isTradingTime() {
  const { day, hour, minute } = twHourMinuteDay();
  const isWeekday = day >= 1 && day <= 5;
  return isWeekday && (hour > 9 || (hour === 9 && minute >= 0)) && (hour < 13 || (hour === 13 && minute <= 30));
}

function decodeXml(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function stripHtml(s = '') {
  return decodeXml(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function cleanGoogleTitle(raw = '') {
  const text = stripHtml(raw);
  const parts = text.split(' - ');
  if (parts.length <= 1) return text.trim();
  return parts.slice(0, -1).join(' - ').trim() || text.trim();
}

function tagValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeXml(m[1]) : '';
}

function tagAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i'));
  return m ? decodeXml(m[1]) : '';
}

async function fetchGoogleRss(query, limit = 20) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const res = await fetch(rssUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
    },
  });
  if (!res.ok) throw new Error(`Google RSS HTTP ${res.status}`);
  const xml = await res.text();
  const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const out = [];
  for (const m of matches.slice(0, limit)) {
    const item = m[1];
    const rawTitle = tagValue(item, 'title');
    const title = cleanGoogleTitle(rawTitle);
    const link = tagValue(item, 'link') || '#';
    const source = tagValue(item, 'source') || tagAttr(item, 'source', 'url') || 'Google News';
    const pubDate = tagValue(item, 'pubDate');
    const ts = pubDate ? Date.parse(pubDate) : Date.now();
    if (!title) continue;
    out.push({ title, link, src: source, pub: Number.isFinite(ts) ? ts : Date.now(), rawTitle });
  }
  return out.sort((a, b) => b.pub - a.pub);
}

function upsertStock(code, name) {
  if (!/^\d{4}$/.test(String(code || '')) || !String(name || '').trim()) return;
  db.prepare(`
    INSERT INTO stocks(code, name, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
  `).run(String(code).trim(), String(name).trim(), nowMs());
}

function getStockName(code) {
  const row = db.prepare('SELECT name FROM stocks WHERE code = ?').get(String(code).trim());
  return row?.name || '';
}

function isStockNewsDue(code, force = false) {
  if (force) return true;
  const row = db.prepare('SELECT last_refresh_at FROM stock_refresh_state WHERE code = ?').get(String(code).trim());
  if (!row) return true;
  return nowMs() - Number(row.last_refresh_at || 0) >= STOCK_NEWS_COOLDOWN_MS;
}

function saveStockRefreshState(code, name) {
  db.prepare(`
    INSERT INTO stock_refresh_state(code, name, last_refresh_at)
    VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, last_refresh_at=excluded.last_refresh_at
  `).run(String(code).trim(), String(name).trim(), nowMs());
}

async function refreshOneStockNews(code, name, { force = false } = {}) {
  const finalCode = String(code || '').trim();
  const finalName = String(name || getStockName(finalCode) || '').trim();
  if (!/^\d{4}$/.test(finalCode) || !finalName) {
    return { ok: false, code: finalCode, name: finalName, error: 'missing code or name', fetched: 0, written: 0, items: [] };
  }

  upsertStock(finalCode, finalName);

  if (!isStockNewsDue(finalCode, force)) {
    const items = getStockNews(finalCode);
    return { ok: true, code: finalCode, name: finalName, skipped: true, reason: 'cooldown', fetched: 0, written: 0, items };
  }

  const query = finalName; // 只搜尋股名
  const rssItems = await fetchGoogleRss(query, 20);
  let fetched = 0;
  let written = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO stock_news(code, name, title, link, src, pub, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const n of rssItems) {
    if (fetched >= STOCK_NEWS_MAX) break;
    const title = String(n.title || '').trim();
    const rawTitle = String(n.rawTitle || '').trim();
    const haystack = `${title} ${rawTitle}`;

    // 收進來前只看中文股名，避免「新唐」抓到「唐宇澤」這類資料。
    if (!haystack.includes(finalName)) continue;

    fetched++;
    const info = insert.run(finalCode, finalName, title, n.link || title, n.src || 'Google News', n.pub || nowMs(), nowMs());
    if (info.changes > 0) written++;
  }

  saveStockRefreshState(finalCode, finalName);
  cleanupStockNews();
  const items = getStockNews(finalCode);
  return { ok: true, code: finalCode, name: finalName, query, fetched, written, items };
}

function getStockNews(code) {
  return db.prepare(`
    SELECT title, link, src, pub
    FROM stock_news
    WHERE code = ?
    ORDER BY pub DESC
    LIMIT ?
  `).all(String(code).trim(), STOCK_NEWS_MAX);
}

function cleanupStockNews() {
  const cutoff = nowMs() - STOCK_NEWS_KEEP_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM stock_news WHERE pub < ?').run(cutoff);
}

async function refreshSectorNews() {
  const query = '富聯網 熱門族群';
  const rssItems = await fetchGoogleRss(query, 30);
  let fetched = 0;
  let written = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sector_news(title, link, src, pub, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const n of rssItems) {
    const title = String(n.title || '').trim();
    const rawTitle = String(n.rawTitle || '').trim();
    const haystack = `${title} ${rawTitle} ${n.src || ''}`;
    if (!haystack.includes('熱門族群')) continue;
    fetched++;
    const info = insert.run(title, n.link || title, n.src || 'Google News', n.pub || nowMs(), nowMs());
    if (info.changes > 0) written++;
  }
  cleanupSectorNews();
  return { ok: true, query, fetched, written, items: getSectorNews() };
}

function getSectorNews() {
  return db.prepare(`
    SELECT title, link AS url, src, pub AS ts
    FROM sector_news
    ORDER BY pub DESC
    LIMIT 150
  `).all();
}

function cleanupSectorNews() {
  const cutoff = nowMs() - SECTOR_KEEP_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM sector_news WHERE pub < ?').run(cutoff);
}

async function refreshBatchStocks(stocks = [], { force = false } = {}) {
  let checked = 0;
  let fetched = 0;
  let written = 0;
  const results = [];

  for (const s of stocks) {
    const code = String(s.code || '').trim();
    const name = String(s.name || '').trim();
    if (!/^\d{4}$/.test(code) || !name) continue;
    checked++;
    try {
      const r = await refreshOneStockNews(code, name, { force });
      fetched += r.fetched || 0;
      written += r.written || 0;
      results.push({ code, name, fetched: r.fetched || 0, written: r.written || 0, skipped: !!r.skipped });
    } catch (e) {
      results.push({ code, name, error: e.message });
    }
  }
  return { ok: true, checked, fetched, written, results };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'stockradar-news-render', time: new Date().toISOString() });
});

app.post('/api/stocks', (req, res) => {
  const stocks = Array.isArray(req.body?.stocks) ? req.body.stocks : [];
  let count = 0;
  for (const s of stocks) {
    const before = db.prepare('SELECT code FROM stocks WHERE code = ?').get(String(s.code || '').trim());
    upsertStock(s.code, s.name);
    if (!before) count++;
  }
  res.json({ ok: true, received: stocks.length, inserted_new: count });
});

app.get('/api/stock-news', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!/^\d{4}$/.test(code)) return res.json([]);
  res.json(getStockNews(code));
});

app.get('/api/refresh-stock-news-code', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const name = String(req.query.name || getStockName(code) || '').trim();
    const force = req.query.force === '1' || req.query.refresh === '1';
    const result = await refreshOneStockNews(code, name, { force });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/refresh-stock-news-batch', async (req, res) => {
  try {
    const stocks = Array.isArray(req.body?.stocks) ? req.body.stocks : [];
    const force = req.query.force === '1' || req.body?.force === true;
    const result = await refreshBatchStocks(stocks, { force });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sectors', (req, res) => {
  res.json(getSectorNews());
});

app.get('/api/refresh-sectors', async (req, res) => {
  try {
    const result = await refreshSectorNews();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug-google-rss', async (req, res) => {
  try {
    const name = String(req.query.name || '台積電').trim();
    const items = await fetchGoogleRss(name, 10);
    res.json({ ok: true, query: name, count: items.length, sample: items.slice(0, 5) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Render 內建排程：盤中每分鐘處理「已同步到 stocks 表的股票」，但每檔仍有 1 小時 cooldown。
cron.schedule('* * * * *', async () => {
  try {
    if (!isTradingTime()) return;
    const rows = db.prepare('SELECT code, name FROM stocks ORDER BY updated_at DESC LIMIT 80').all();
    await refreshBatchStocks(rows, { force: false });
  } catch (e) {
    console.error('cron trading stock news error:', e.message);
  }
}, { timezone: TZ });

// 熱門族群：每 10 分鐘抓一次，有重複就不寫入。
cron.schedule('*/10 * * * *', async () => {
  try {
    await refreshSectorNews();
  } catch (e) {
    console.error('cron sector news error:', e.message);
  }
}, { timezone: TZ });

// 非盤中：每 3 小時補抓一次已同步股票，仍受 cooldown 控制。
cron.schedule('0 */3 * * *', async () => {
  try {
    if (isTradingTime()) return;
    const rows = db.prepare('SELECT code, name FROM stocks ORDER BY updated_at DESC LIMIT 80').all();
    await refreshBatchStocks(rows, { force: false });
  } catch (e) {
    console.error('cron offhour stock news error:', e.message);
  }
}, { timezone: TZ });

app.listen(PORT, () => {
  console.log(`stockradar-news-render listening on ${PORT}`);
});
