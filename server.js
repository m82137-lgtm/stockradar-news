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
// 富聯網列表頁時間格式：「來源 2026/06/02 17:43」，是台灣時間。
// 解析成帶 +08:00 的 ISO（存成 UTC），讓前端 new Date() 顯示正確時間。
function moneyLinkDateToIso(seg) {
  // 日期與時間之間可能是空白/&nbsp;/標籤，用「1~10 個非數字字元」容錯
  const dm = seg.match(/(\d{4})\/(\d{2})\/(\d{2})[^\d]{1,10}(\d{2}):(\d{2})/);
  if (!dm) return new Date().toISOString();
  const iso = `${dm[1]}-${dm[2]}-${dm[3]}T${dm[4]}:${dm[5]}:00+08:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

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

    const hot = html.match(/熱門族群/g);
    if (hot) totalHotCount += hot.length;

    // 先收集本頁所有「標題項目」的位置，之後在每則與下一則之間那段 HTML 找發布時間
    const found = [];
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(html)) !== null) {
      found.push({ href: m[1].trim(), title: m[2].trim(), end: linkRe.lastIndex });
    }

    for (let i = 0; i < found.length; i++) {
      const { href, title, end } = found[i];
      if (!title || seen.has(href)) continue;
      seen.add(href);
      if (!isHotSectorTitle(title)) continue;

      // 本則標題之後、下一則標題之前的那段，含「來源 + 發布日期時間」
      const sliceEnd = (i + 1 < found.length) ? found[i + 1].end : html.length;
      const pub = moneyLinkDateToIso(html.slice(end, sliceEnd));

      const link = href.startsWith("http") ? href : `https://ww2.money-link.com.tw/realtimenews/${href}`;
      items.push({ title, link, pub, src: "富聯網" });
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

// ── 上櫃每日收盤行情代打：Worker 打不到櫃買(Cloudflare 擋 Worker)，改由 Render 代打 ──
// 來源：櫃買 OpenAPI「上櫃股票每日收盤行情(不含定價)」，一次回全部上櫃股
// 回傳正規化後的清單：code / name / close / chgPct / vol(張) / tradeValue(元)
async function fetchOtcDaily() {
  const TPEX = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";
  const r = await fetch(TPEX, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "Referer": "https://www.tpex.org.tw/zh-tw/index.html",
    },
  });
  const status = r.status;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!Array.isArray(json)) {
    return { ok: false, status, head: text.slice(0, 200), data: [] };
  }
  const num = (s) => {
    const n = parseFloat(String(s == null ? "" : s).replace(/,/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const data = [];
  for (const row of json) {
    const code = String(row.SecuritiesCompanyCode || "").trim();
    if (!/^\d{4}$/.test(code)) continue;
    const close = num(row.Close);
    const change = num(row.Change);
    const tradeValue = num(row.TransactionAmount);
    const volume = num(row.TradingShares);
    if (close <= 0 || tradeValue <= 0) continue;
    const prevClose = close - change;
    const chgPct = prevClose > 0 ? +((change / prevClose) * 100).toFixed(2) : 0;
    data.push({
      code,
      name: String(row.CompanyName || "").trim(),
      close,
      chgPct,
      vol: Math.round(volume / 1000),
      tradeValue,
    });
  }
  return { ok: true, status, date: json[0]?.Date || null, count: data.length, data };
}

// ── 上市每日收盤行情代打：Worker 打不到 TWSE(Cloudflare 海外 IP 被擋)，改由 Render 代打 ──
// 來源：證交所 STOCK_DAY_ALL「當日各股全部成交資訊」，一次回全部上市股
// 回傳正規化後的清單：code / name / close / chgPct / vol(張) / tradeValue(元)，格式與 OTC 一致
async function fetchTseDaily() {
  const TWSE = "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json";
  const r = await fetch(TWSE, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "Referer": "https://www.twse.com.tw/zh/index.html",
    },
  });
  const status = r.status;
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!json || json.stat !== "OK" || !Array.isArray(json.data)) {
    return { ok: false, status, head: text.slice(0, 200), data: [] };
  }
  const num = (s) => {
    const n = parseFloat(String(s == null ? "" : s).replace(/,/g, "").replace(/\+/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const data = [];
  for (const row of json.data) {
    const code = String(row[0] || "").trim();
    if (!/^\d{4}$/.test(code)) continue;
    const close = num(row[7]);        // 收盤價
    const change = num(row[8]);       // 漲跌價差
    const volume = num(row[2]);       // 成交股數
    const tradeValue = num(row[3]);   // 成交金額
    if (close <= 0 || tradeValue <= 0) continue;
    const prevClose = close - change;
    const chgPct = prevClose > 0 ? +((change / prevClose) * 100).toFixed(2) : 0;
    data.push({
      code,
      name: String(row[1] || "").trim(),
      close,
      chgPct,
      vol: Math.round(volume / 1000),
      tradeValue,
    });
  }
  return { ok: true, status, date: json.date || null, count: data.length, data };
}


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

// 上市每日收盤行情代打：Worker 的 buildDailyData 會打這支拿 TSE 資料
app.get("/api/tse-daily", async (req, res) => {
  try {
    const result = await fetchTseDaily();
    if (!result.ok) {
      console.log(`/api/tse-daily 失敗 status=${result.status} head=${result.head}`);
      return res.status(502).json(result);
    }
    console.log(`/api/tse-daily 成功 date=${result.date} count=${result.count}`);
    res.json(result);
  } catch (e) {
    console.error("/api/tse-daily error:", e.message);
    res.status(500).json({ ok: false, error: e.message, data: [] });
  }
});

// 上櫃每日收盤行情代打：Worker 的 buildDailyData 會打這支拿 OTC 資料
app.get("/api/otc-daily", async (req, res) => {
  try {
    const result = await fetchOtcDaily();
    if (!result.ok) {
      console.log(`/api/otc-daily 失敗 status=${result.status} head=${result.head}`);
      return res.status(502).json(result);
    }
    console.log(`/api/otc-daily 成功 date=${result.date} count=${result.count}`);
    res.json(result);
  } catch (e) {
    console.error("/api/otc-daily error:", e.message);
    res.status(500).json({ ok: false, error: e.message, data: [] });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await updateSectorNews();
});
