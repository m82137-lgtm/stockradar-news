import express from "express";
import cron from "node-cron";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;

// Cloudflare KV 設定
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_KV_TOKEN = process.env.CF_KV_TOKEN;
const KV_API = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values`;

const HOT_SECTOR_KEEP_DAYS = 15;

function now() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}

// 回傳 ISO 格式，讓前端 new Date() 可以正確解析
function parsePubDate(pubDateStr) {
  if (!pubDateStr) return new Date().toISOString();
  try {
    const d = new Date(pubDateStr);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ── Cloudflare KV 操作 ─────────────────────────
async function kvGet(key) {
  try {
    const res = await fetch(`${KV_API}/${key}`, {
      headers: { Authorization: `Bearer ${CF_KV_TOKEN}` }
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function kvPut(key, value, ttlSeconds) {
  try {
    const params = ttlSeconds ? `?expiration_ttl=${ttlSeconds}` : '';
    const res = await fetch(`${KV_API}/${key}${params}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${CF_KV_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Google RSS ─────────────────────────────────
async function fetchGoogleRSS(keyword) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    return text;
  } catch (err) {
    console.log("RSS error:", err.message);
    return "";
  }
}

function parseRSS(rss) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(rss)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>(.*?)<\/title>/);
    const linkMatch = block.match(/<link>(.*?)<\/link>/);
    const pubMatch = block.match(/<pubDate>(.*?)<\/pubDate>/);

    const rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : "";
    const link = linkMatch ? linkMatch[1].trim() : "";
    const pubDate = pubMatch ? pubMatch[1].trim() : "";

    if (!rawTitle || rawTitle === "Google 新聞" || rawTitle === "Google News") continue;

    let title = rawTitle;
    let src = "Google RSS";
    const dashIdx = rawTitle.lastIndexOf(" - ");
    if (dashIdx !== -1) {
      title = rawTitle.substring(0, dashIdx).trim();
      src = rawTitle.substring(dashIdx + 3).trim();
    }

    items.push({
      title,
      link,
      pub: parsePubDate(pubDate),
      src
    });
  }

  return items.slice(0, 20);
}

function uniqueNews(items) {
  const seenTitles = new Set();
  const seenLinks = new Set();
  return items.filter(item => {
    const title = (item.title || '').trim();
    const link = item.link || '';
    if (title && seenTitles.has(title)) return false;
    if (link && seenLinks.has(link)) return false;
    if (title) seenTitles.add(title);
    if (link) seenLinks.add(link);
    return true;
  });
}

// 判斷是否有新新聞
function hasNewItems(newItems, oldItems) {
  const oldLinks = new Set((oldItems || []).map(n => n.link).filter(Boolean));
  return (newItems || []).some(n => n.link && !oldLinks.has(n.link));
}

// 合併新舊新聞，保留 keepDays 天，用標題去重
function mergeNews(newItems, oldItems, keepDays) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const seenTitles = new Set();
  const seenLinks = new Set();
  const merged = [];

  for (const item of [...newItems, ...(oldItems || [])]) {
    // 用標題去重（主要），link 去重（次要）
    const titleKey = item.title ? item.title.trim() : '';
    const linkKey = item.link || '';
    if (titleKey && seenTitles.has(titleKey)) continue;
    if (linkKey && seenLinks.has(linkKey)) continue;
    if (titleKey) seenTitles.add(titleKey);
    if (linkKey) seenLinks.add(linkKey);

    const pubMs = new Date(item.pub).getTime();
    if (pubMs >= cutoff) merged.push(item);
  }

  return merged.sort((a, b) => new Date(b.pub) - new Date(a.pub));
}

// ── 通用 HTML fetch（帶完整瀏覽器 headers 避免 403）─
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchHtml(url, extraHeaders = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        ...extraHeaders
      }
    });
    if (!res.ok) {
      console.log(`fetchHtml ${url} status: ${res.status}`);
      return "";
    }
    return await res.text();
  } catch (e) {
    console.log(`fetchHtml ${url} error:`, e.message);
    return "";
  }
}

// 過濾條件：標題開頭含「《熱門族群》」
function isHotSectorTitle(title) {
  if (!title) return false;
  return title.trim().startsWith("《熱門族群》");
}

// ── 富聯網爬蟲：抓「新聞 > 台股新聞」分類 (NType=0002) 前 10 頁 ──
// 翻頁參數 PGNum，第 1 頁無參數，第 2~10 頁加 &PGNum=N
// 《熱門族群》發布後會被其他新聞往後擠，抓 10 頁(約200則)降低漏接
async function fetchMoneyLink() {
  const items = [];
  const seen = new Set();
  const linkRe = /<a[^>]+href="([^"]*NewsContent\.aspx[^"]*)"[^>]*>\s*<h3>([^<]+)<\/h3>/gi;
  
  let totalHotCount = 0;

  for (let page = 1; page <= 10; page++) {
    const url = page === 1
      ? "https://ww2.money-link.com.tw/realtimenews/Index.aspx?NType=0002"
      : `https://ww2.money-link.com.tw/realtimenews/Index.aspx?NType=0002&PGNum=${page}`;

    const html = await fetchHtml(url, {
      "Referer": "https://ww2.money-link.com.tw/"
    });
    if (!html) continue;


    const matches = html.match(/熱門族群/g);
    if (matches) totalHotCount += matches.length;


    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1].trim();
      let title = m[2].trim();
      if (!title || seen.has(href)) continue;
      seen.add(href);
      if (!isHotSectorTitle(title)) continue;

      const link = href.startsWith("http") ? href : `https://ww2.money-link.com.tw/realtimenews/${href}`;
      items.push({
        title,
        link,
        pub: new Date().toISOString(),
        src: "富聯網"
      });
    }

    // 頁與頁之間小延遲，避免被限流
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`富聯網：10頁共「熱門族群」字串 ${totalHotCount} 次，抓到 ${items.length} 則《熱門族群》`);
  return items;
}



// ── 工商時報：因 Cloudflare 擋 Render 雲端 IP，已移除（未來用付費代理可加回）─

// ── 熱門族群：2 個爬蟲源 + 2 組 Google RSS → 比對新舊 → 有新才寫 KV ──
async function updateSectorNews() {
  console.log(`[${now()}] 更新熱門族群新聞`);

  try {
    // 並聯抓取：富聯網 + Google RSS 兩組關鍵字
    const [rss1, rss2, moneyLinkItems] = await Promise.all([
      fetchGoogleRSS("富聯網 熱門族群"),
      fetchGoogleRSS("熱門族群"),
      fetchMoneyLink().catch(e => { console.log("富聯網 error:", e.message); return []; }),
    ]);

    // Google RSS 兩組合併，只留標題開頭「《熱門族群》」的
    const rssItems = [...parseRSS(rss1), ...parseRSS(rss2)].filter(it => isHotSectorTitle(it.title));
    console.log(`Google RSS：抓到 ${rssItems.length} 則《熱門族群》（兩組關鍵字合計）`);

    // 合併，依標題去重
    const allItems = [...rssItems, ...moneyLinkItems];
    const newItems = uniqueNews(allItems);

    if (!newItems.length) {
      console.log("熱門族群：無新聞");
      return;
    }

    // 讀取舊 KV
    const oldData = await kvGet('sectors');
    const oldItems = Array.isArray(oldData) ? oldData : [];

    if (!hasNewItems(newItems, oldItems)) {
      console.log("熱門族群：無新新聞，跳過寫入");
      return;
    }

    // 合併保留 15 天
    const merged = mergeNews(newItems, oldItems, HOT_SECTOR_KEEP_DAYS);

    // 寫入 KV，TTL 16 天
    const ok = await kvPut('sectors', merged, 60 * 60 * 24 * 16);
    console.log(`熱門族群：${newItems.length} 則新，合計 ${merged.length} 則，寫入KV ${ok ? '✅' : '❌'}`);

  } catch (e) {
    console.error("updateSectorNews error:", e.message);
  }
}

// 盤中：UTC 01:00~06:59（台灣時間 09:00~14:59）週一~五每5分鐘
cron.schedule("*/5 1-6 * * 1-5", async () => {
  await updateSectorNews();
});

// 非盤中：每5分鐘
cron.schedule("*/5 * * * *", async () => {
  await updateSectorNews();
});

// 健康檢查（UptimeRobot ping 用）
app.get("/", (req, res) => {
  res.send("stockradar-news running");
});

// 個股新聞：即時查詢，3 組關鍵字，不存 KV
app.get("/api/stock-news", async (req, res) => {
  const name = (req.query.name || "").trim();
  const code = (req.query.code || "").trim();

  if (!name && !code) {
    return res.json([{ time: now(), keyword: "", items: [] }]);
  }

  const searches = [name, `${name} ${code}`, code].filter(q => q.trim());
  let allItems = [];

  for (const q of searches) {
    try {
      const rss = await fetchGoogleRSS(q);
      const items = parseRSS(rss);
      allItems.push(...items);
    } catch (e) {
      console.log("RSS fail:", q);
    }
  }

  const sorted = uniqueNews(allItems).sort((a, b) => new Date(b.pub) - new Date(a.pub)).slice(0, 15);
  res.json([{
    time: now(),
    keyword: `${name} ${code}`,
    items: sorted
  }]);
});

// 熱門族群：從 KV 讀取（15天歷史），若空則即時抓一次
app.get("/api/sectors", async (req, res) => {
  try {
    let data = await kvGet('sectors');
    let items = Array.isArray(data) ? data : [];

    // KV 是空的，即時抓一次
    if (!items.length) {
      await updateSectorNews();
      data = await kvGet('sectors');
      items = Array.isArray(data) ? data : [];
    }

    res.json([{
      time: now(),
      keyword: "富聯網 熱門族群",
      items
    }]);
  } catch (e) {
    res.json([{ time: now(), keyword: "富聯網 熱門族群", items: [] }]);
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await updateSectorNews();
});
