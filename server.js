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

// Telegram 推播設定（存 Render 環境變數；沒設則靜默不推，不影響新聞功能）
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const HOT_SECTOR_KEEP_DAYS = 30;

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

// ── 富聯網爬蟲：抓「新聞 > 台股新聞」分類 (NType=0002) 前 15 頁 ──
// 翻頁參數 PGNum，第 1 頁無參數，第 2~15 頁加 &PGNum=N
// 《熱門族群》發布後會被其他新聞往後擠，抓 15 頁(150則)降低漏接(盤後投信買賣超會洗版)
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

  for (let page = 1; page <= 15; page++) {
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

  console.log(`富聯網：15頁共「熱門族群」字串 ${totalHotCount} 次，抓到 ${items.length} 則《熱門族群》`);
  return items;
}



// ── 工商時報：因 Cloudflare 擋 Render 雲端 IP，已移除（未來用付費代理可加回）─

// ── Telegram 推播工具 ───────────────────────────
function escHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ISO → 台灣時間 MM/DD HH:MM
function fmtTwShort(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const tw = new Date(d.getTime() + 8 * 3600 * 1000);
    const mm = String(tw.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(tw.getUTCDate()).padStart(2, "0");
    const hh = String(tw.getUTCHours()).padStart(2, "0");
    const mi = String(tw.getUTCMinutes()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${mi}`;
  } catch {
    return "";
  }
}

// 送 Telegram 訊息（沒設 Token/ChatID 就靜默跳過，回傳 false 不報錯）
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.log(`TG send 失敗 status=${res.status}`);
    return res.ok;
  } catch (e) {
    console.log("TG send error:", e.message);
    return false;
  }
}

// 單則熱門族群新聞 → TG 訊息（標題做成超連結 + 附裸網址，確保點得到）
// ── chip 補爬：對「富聯網直爬版但 stocks 空」的新聞補抓指標股 ──
// 每輪最多 5 則、每則最多試 3 次。fetchHtml 失敗不計次（網路問題不消耗機會），
// 爬成功但沒股號才 +1，滿 3 次放棄（推測該篇本來就沒寫股號）。
// 次數記憶體+KV雙軌：盤中隨寫入持久化，process 重啟最多重試幾次、無害。
const CHIP_REFILL_MAX_PER_ROUND = 5;
const CHIP_MAX_TRIES = 3;
const chipTryMem = new Map(); // link -> 已嘗試次數

async function refillChips(items, codeNameMap) {
  const candidates = items.filter(it =>
    it.src === "富聯網" &&
    /^https?:\/\//.test(it.link || "") &&
    (!Array.isArray(it.stocks) || !it.stocks.length) &&
    Math.max(it.chipTries || 0, chipTryMem.get(it.link) || 0) < CHIP_MAX_TRIES
  ).slice(0, CHIP_REFILL_MAX_PER_ROUND);

  let gained = 0;
  for (const item of candidates) {
    const html = await fetchHtml(item.link); // 失敗回 ""，已自帶 log
    if (html) {
      const stocks = extractStocks(html, codeNameMap);
      if (stocks.length) { item.stocks = stocks; gained++; }
      else {
        const t = Math.max(item.chipTries || 0, chipTryMem.get(item.link) || 0) + 1;
        item.chipTries = t;
        chipTryMem.set(item.link, t);
      }
    }
    await new Promise(r => setTimeout(r, 300)); // 控速
  }
  if (candidates.length) console.log(`chip補爬：掃 ${candidates.length} 則，補到 ${gained} 則`);
  return gained;
}

function formatSectorTg(item) {
  const title = escHtml(item.title || "");
  const src   = escHtml(item.src || "富聯網");
  const time  = fmtTwShort(item.pub);
  const url   = escHtml(item.link || "");
  // 指標股那行（有抓到才顯示）：🎯 長榮(2603) 陽明(2609) 萬海(2615)
  const stocks = Array.isArray(item.stocks) ? item.stocks : [];
  const stockLine = stocks.length
    ? `🎯 ${stocks.map(s => `${escHtml(s.name)}(${s.code})`).join(" ")}\n`
    : "";
  // 第二行：標題本身是可點超連結（不附裸網址、不顯示預覽）
  return `📊 熱門族群新聞\n<a href="${url}">${title}</a>\n${stockLine}${src} ${time}`;
}

// ── 熱門族群：2 個爬蟲源 + 2 組 Google RSS → 比對新舊 → 有新才寫 KV ──
// ── 從富聯網內文抓「指標股」：regex 抓括號裡的股號 (4~6位數字) → 用對照表驗證是不是真台股 ──
// 富聯網內文格式固定是「股名(股號)」，所以只抓括號數字、再用對照表過濾，年份/價格那種裸數字天然不會中。
// 注意：富聯網用「全形括號（）」，也相容半形 ()。對照表可能是舊格式 {code:name} 或新格式 {code:{name,market}}。
function extractStocks(html, codeNameMap) {
  if (!html || !codeNameMap) return [];
  const out = [];
  const seen = new Set();
  const re = /[（(](\d{4,6})[）)]/g;   // 全形（）與半形() 都吃
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = m[1];
    if (seen.has(code)) continue;
    const entry = codeNameMap[code];
    if (!entry) continue;          // 對照表沒有 → 不是台股（排除年份2026、價格等）
    // 相容新舊格式：舊 = 字串(股名)；新 = 物件 {name, market}
    const name   = typeof entry === "string" ? entry : entry.name;
    const market = typeof entry === "string" ? "" : (entry.market || "");
    if (!name) continue;
    seen.add(code);
    out.push({ code, name, market });
    if (out.length >= 30) break;  // 上限保險
  }
  return out;
}

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

    // 合併，依標題去重。富聯網排前面 → 同標題保留富聯網版(有真內頁能爬內文)
    const allItems = [...moneyLinkItems, ...rssItems];
    const newItems = uniqueNews(allItems);

    if (!newItems.length) {
      console.log("熱門族群：無新聞");
      return;
    }

    // 讀取舊 KV
    const oldData = await kvGet('sectors');
    const oldItems = Array.isArray(oldData) ? oldData : [];

    // 這次相對 KV 舊資料「真正新進」的新聞
    // link + 標題雙重比對（與 mergeNews 去重鍵一致）：同一則新聞的「富聯網直爬版」
    // 與「Google RSS 版」連結不同，只比 link 會把舊聞誤判成新進 → 加比標題堵住
    const oldLinks  = new Set(oldItems.map(n => n.link).filter(Boolean));
    const oldTitles = new Set(oldItems.map(n => (n.title || '').trim()).filter(Boolean));
    const freshItems = newItems.filter(n =>
      n.link && !oldLinks.has(n.link) &&
      !(n.title && oldTitles.has(n.title.trim()))
    );

    // 對照表提前載入（補爬與新進掃描共用；KV 讀取額度寬鬆、多讀無妨）
    const codeNameMap = await kvGet('code_name_map') || {};
    const mapReady = Object.keys(codeNameMap).length > 50;

    if (!freshItems.length) {
      // 無新新聞：順手補爬 KV 裡缺 chip 的舊新聞，有補到才額外寫一次 KV（沒補到不寫、零浪費）
      if (mapReady) {
        const gained = await refillChips(oldItems, codeNameMap);
        if (gained) {
          const ok2 = await kvPut('sectors', oldItems, 60 * 60 * 24 * 31);
          console.log(`熱門族群：無新新聞，chip補爬回寫 ${gained} 則，寫入KV ${ok2 ? '✅' : '❌'}`);
          return;
        }
      }
      console.log("熱門族群：無新新聞，跳過寫入");
      return;
    }

    // ── 對「新進的富聯網新聞」爬內文抓指標股（freshItems 才爬，舊的股號已在 KV 不重爬）──
    if (mapReady) {
      const toScan = freshItems.filter(it => it.src === "富聯網" && /^https?:\/\//.test(it.link || ""));
      let hit = 0;
      for (const item of toScan) {
        try {
          const html = await fetchHtml(item.link);
          item.stocks = extractStocks(html, codeNameMap);
          if (item.stocks.length) hit++;
        } catch (e) {
          item.stocks = [];
        }
        await new Promise(r => setTimeout(r, 300)); // 控速，避免打太兇
      }
      console.log(`指標股：掃 ${toScan.length} 則內文，${hit} 則抓到股號`);
    } else {
      console.log("指標股：對照表未就緒，跳過抓股號");
    }

    // ── chip 保留（修洗掉 bug）：還在 15 頁內的舊新聞每輪會重爬進 newItems（沒 stocks），
    // mergeNews 新蓋舊會把 KV 已抓到的指標股洗掉 → 合併前把舊版 stocks/chipTries 搬過來（標題對齊）──
    const oldByTitle = new Map(oldItems.filter(n => n.title).map(n => [n.title.trim(), n]));
    for (const it of newItems) {
      const old = it.title ? oldByTitle.get(it.title.trim()) : null;
      if (!old) continue;
      if ((!Array.isArray(it.stocks) || !it.stocks.length) && Array.isArray(old.stocks) && old.stocks.length) {
        it.stocks = old.stocks;
      }
      if (old.chipTries && !it.chipTries) it.chipTries = old.chipTries;
    }

    // 合併保留 15 天
    const merged = mergeNews(newItems, oldItems, HOT_SECTOR_KEEP_DAYS);

    // chip 補爬：對合併後仍缺 chip 的補抓，跟著下面同一次 KV 寫入、零額外寫入
    if (mapReady) await refillChips(merged, codeNameMap);

    // 寫入 KV，TTL 16 天
    const ok = await kvPut('sectors', merged, 60 * 60 * 24 * 31);
    console.log(`熱門族群：${freshItems.length} 則新，合計 ${merged.length} 則，寫入KV ${ok ? '✅' : '❌'}`);

    // ── TG 推播：KV 寫入成功後，只推這次新進、且來源為富聯網的（連結乾淨可點）──
    // 一則一則推；已看過的新聞在 freshItems 那關就被擋掉，不會重複推。
    // 保險絲：發布時間 12 小時內才推（就算前面誤判，舊聞也推不出去；pub 壞掉算 NaN 也擋）
    if (ok) {
      const PUSH_WINDOW_MS = 12 * 60 * 60 * 1000;
      const toPush = freshItems.filter(it =>
        it.src === "富聯網" &&
        /^https?:\/\//.test(it.link || "") &&
        (Date.now() - new Date(it.pub).getTime()) < PUSH_WINDOW_MS
      ).sort((a, b) => new Date(a.pub) - new Date(b.pub)); // 同批按發稿時間先舊後新推，TG 由上往下讀才順
      for (const item of toPush) {
        await sendTelegram(formatSectorTg(item));
        await new Promise(r => setTimeout(r, 400)); // 間隔避免 TG 限流
      }
      if (toPush.length) console.log(`TG 推播熱門族群 ${toPush.length} 則（富聯網）`);
    }

  } catch (e) {
    console.error("updateSectorNews error:", e.message);
  }
}

// ── 台股新聞（鉅亨網）：搬自 Worker，每5分鐘抓 → 有新才寫 KV 'news' ──
// 前端鉅亨認的格式是 {title, url, time, cat, ts}，用 url/ts 自己一套去重
// （不共用熱門族群的 mergeNews，因為那套找 item.pub，鉅亨是 ts，硬套會把新聞全過濾掉）
const CNYES_KEEP_DAYS = 15;
const CNYES_MAX = 300;

function cnyesKey(n) { return n.url || (n.title || '').trim(); }

function cnyesMerge(newItems, oldItems) {
  const map = new Map();
  for (const n of [...(oldItems || []), ...(newItems || [])]) {
    const key = cnyesKey(n);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev || (n.ts || 0) > (prev.ts || 0)) map.set(key, n);
  }
  const cutoff = Date.now() - CNYES_KEEP_DAYS * 24 * 60 * 60 * 1000;
  return [...map.values()]
    .filter(n => (n.ts || 0) > cutoff)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, CNYES_MAX);
}

function cnyesHasNew(newItems, oldItems) {
  const oldKeys = new Set((oldItems || []).map(cnyesKey).filter(Boolean));
  return (newItems || []).some(n => !oldKeys.has(cnyesKey(n)));
}

async function updateTwNews() {
  console.log(`[${now()}] 更新台股新聞（鉅亨）`);
  try {
    const newItems = [];
    const categories = ['tw_stock_news', 'tw_stock_headline', 'tw_stock'];
    for (const cat of categories) {
      try {
        const res  = await fetch(`https://api.cnyes.com/media/api/v1/newslist/category/${cat}?limit=200&page=1`);
        const json = await res.json();
        const data = json?.items?.data || [];
        for (const n of data) {
          newItems.push({
            title: n.title,
            time:  new Date(n.publishAt * 1000).toLocaleString('zh-TW', {
              timeZone: 'Asia/Taipei',
              year: 'numeric', month: 'numeric', day: 'numeric',
              hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
            }),
            url:  `https://news.cnyes.com/news/id/${n.newsId}`,
            cat:  (n.categoryName || '').split(',')[0].trim(),
            ts:   n.publishAt * 1000,
          });
        }
      } catch (e) { console.log(`鉅亨 ${cat} error:`, e.message); }
    }

    if (!newItems.length) { console.log('台股新聞：無資料'); return; }

    const oldItems = (await kvGet('news')) || [];
    const merged = cnyesMerge(newItems, oldItems);

    if (!cnyesHasNew(newItems, oldItems)) {
      console.log('台股新聞：無新新聞，跳過寫入');
      return;
    }
    const ok = await kvPut('news', merged, 60 * 60 * 24 * 16);
    console.log(`台股新聞：${newItems.length} 則候選，合計 ${merged.length}，寫入KV ${ok ? '✅' : '❌'}`);
  } catch (e) {
    console.error('updateTwNews error:', e.message);
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
      market: "OTC",
      close,
      chgPct,
      vol: Math.round(volume / 1000),
      tradeValue,
    });
  }
  return { ok: true, status, date: json[0]?.Date || null, count: data.length, data };
}

// ══════════════ 台股 Top50（比照美股，全程在 Render，資料源：TWSE上市 + 櫃買上櫃）══════════════
// 上市每日收盤：TWSE STOCK_DAY_ALL（一次回全部上市股，含成交金額=成交值）
async function fetchTseDaily() {
  const URL = "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?response=json";
  const r = await fetch(URL, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "Referer": "https://www.twse.com.tw/",
    },
  });
  const status = r.status;
  const text = await r.text();
  // TWSE 此 API 為 CSV：每欄雙引號包住、欄序最前面多一欄「日期」。
  // 砍掉日期欄後對齊：row[0]證券代號 row[1]名稱 row[2]成交股數 row[3]成交金額 row[7]收盤價 row[8]漲跌價差
  const lines = text.trim().split("\n");
  if (lines.length < 2) return { ok: false, status, head: text.slice(0, 200), data: [] };
  const num = (s) => {
    const n = parseFloat(String(s == null ? "" : s).replace(/,/g, "").replace(/\+/g, "").trim());
    return isNaN(n) ? 0 : n;
  };
  const data = [];
  let dateStr = null;
  for (const line of lines) {
    const cols = line.split(",").map(c => c.replace(/^"|"\r?$|"$/g, "").trim());
    if (!dateStr && cols[0] && /^\d/.test(cols[0])) dateStr = cols[0];   // 第一欄是日期
    const row = cols.slice(1);   // 砍掉日期欄
    const code = String(row[0] || "").trim();
    if (!/^\d{4}$/.test(code)) continue;
    const price = num(row[7]);
    const chgAmt = num(row[8]);
    const volume = num(row[2]);
    const tradeValue = num(row[3]);
    if (price <= 0 || tradeValue <= 0) continue;
    const prevClose = price - chgAmt;
    const chgPct = prevClose > 0 ? +((chgAmt / prevClose) * 100).toFixed(2) : 0;
    data.push({
      code, name: String(row[1] || "").trim(), market: "TSE",
      close: price, chgPct, vol: Math.round(volume / 1000), tradeValue,
    });
  }
  return { ok: true, status, date: dateStr, count: data.length, data };
}

// 台股最近一個交易日（YYYY-MM-DD）：台股下午1:30收盤，資料約下午2-3點 ready
// 簡化：用台灣當天日期；若當天非交易日（週末）往前推到週五
function twTradingDate(offsetDays = 0) {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 3600 * 1000);   // UTC→台灣
  tw.setUTCDate(tw.getUTCDate() - offsetDays);
  while (tw.getUTCDay() === 0 || tw.getUTCDay() === 6) tw.setUTCDate(tw.getUTCDate() - 1);
  return tw.toISOString().slice(0, 10);
}

async function buildTwTop50() {
  try {
    // ── 抓上市 + 上櫃（都在 Render）──
    const [tse, otc] = await Promise.all([
      fetchTseDaily().catch(e => { console.error("fetchTseDaily error:", e.message); return { ok: false, data: [] }; }),
      fetchOtcDaily().catch(e => { console.error("fetchOtcDaily error:", e.message); return { ok: false, data: [] }; }),
    ]);
    const tseData = (tse.ok && Array.isArray(tse.data)) ? tse.data : [];
    const otcData = (otc.ok && Array.isArray(otc.data)) ? otc.data : [];
    if (!tseData.length && !otcData.length) return { ok: false, error: "台股上市櫃皆無資料", data: [] };

    // 日期：以上市資料的日期為準（民國年轉西元），抓不到就用台灣當天
    let date = twTradingDate(0);
    const rawDate = tse.date || otc.date || "";
    // TWSE 日期格式可能是「115/06/30」(民國) 或 ISO，櫃買是 ISO。統一轉 YYYY-MM-DD
    const mRoc = rawDate.match(/^(\d{3})\/(\d{2})\/(\d{2})$/);
    if (mRoc) date = `${+mRoc[1] + 1911}-${mRoc[2]}-${mRoc[3]}`;
    else if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) date = rawDate.slice(0, 10);

    // ── 合併、排除 ETF（代碼開頭 00，如 0050/0056/00878）、依成交值排序、取前50 ──
    const isTwEtf = (code) => /^00/.test(String(code));   // 台股 ETF 代碼開頭 00
    const all = [...tseData, ...otcData].filter(s => s.tradeValue > 0 && s.close > 0 && !isTwEtf(s.code));
    all.sort((a, b) => b.tradeValue - a.tradeValue);
    let top50 = all.slice(0, 50).map((s, i) => ({
      rank: i + 1,
      code: s.code, name: s.name, market: s.market,
      price: s.close,
      chg: s.chgPct,
      tradeValue: s.tradeValue,
      vol: s.vol,
    }));

    // ── 在榜天數 + 排名變化 + NEW（比照美股）──
    const snap = (await kvGet("tw_prev_top50")) || { date: "", codes: [] };
    const prevCodes = new Set(snap.codes || []);
    const isFirstRun = !snap.date;
    const hist = (await kvGet("tw_history")) || {};
    const newHist = {};
    top50 = top50.map(s => {
      const h = hist[s.code];
      const isNew = !isFirstRun && !prevCodes.has(s.code);
      const days = h ? (h.days || 1) + 1 : 1;
      const rankChange = h && h.lastRank ? (h.lastRank - s.rank) : 0;
      newHist[s.code] = { days, lastRank: s.rank, firstDate: h?.firstDate || date };
      return { ...s, days, isNew, rankChange };
    });
    await kvPut("tw_history", newHist, 86400 * 30);
    if (snap.date !== date) {
      await kvPut("tw_prev_top50", { date, codes: top50.map(s => s.code) }, 86400 * 7);
    }

    const result = { ok: true, date, count: top50.length, updatedAt: Date.now(), data: top50 };
    await kvPut("tw_top50", result, 86400 * 3);
    console.log(`台股Top50：date=${date} 共${top50.length}檔（TSE ${tseData.length}+OTC ${otcData.length}），新進榜${top50.filter(s => s.isNew).length}檔`);
    return result;
  } catch (e) {
    console.error("buildTwTop50 error:", e.message);
    return { ok: false, error: e.message, data: [] };
  }
}

app.get("/api/tw-top50", async (req, res) => {
  try {
    const cached = await kvGet("tw_top50");
    if (cached && cached.ok) return res.json(cached);
    const fresh = await buildTwTop50();
    res.json(fresh);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, data: [] });
  }
});

app.get("/api/tw-rebuild", async (req, res) => {
  try {
    const r = await buildTwTop50();
    if (r && r.ok && r.data && r.data.length) {
      buildTwAnalysis(r.data, r.date).catch(e => console.error("tw analysis bg:", e.message));
    }
    res.json({ ok: r.ok, date: r.date, count: r.count, note: r.ok ? "台股Top50已更新，AI題材分析背景生成中" : r.error });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 台股題材分析（第二批：發動題材卡片 + 每檔題材標籤；Gemini）──
async function buildTwAnalysis(top50, date) {
  if (!GEMINI_API_KEY) { console.log("台股AI：GEMINI_API_KEY 未設定，跳過"); return; }
  try {
    // 發動題材卡片
    const themePrompt = `你是專業台股財經記者，用繁體中文、台灣投資人口吻。根據以下台股${date}成交值前20名，歸納成「今日發動題材／族群」，依資金熱度排序。
重要規則：
1. 必須列出 4-6 組題材（不要只列1-2組），把前20名的個股盡量都歸類進去，不管漲跌都要分類（成交值大代表資金關注）。
2. 用台股熟悉的族群名，如：晶圓代工、IC設計、記憶體、PCB載板、CCL銅箔基板、被動元件、面板、封測、散熱、矽智財、AI伺服器、金融、光學、網通、ABF載板、CoWoS先進封裝等。
3. desc 要「具體」：點出該族群今天為什麼動（AI需求、漲價、訂單、財報、題材輪動等），不要只寫「表現強勁」。例如「AI伺服器需求帶動PCB載板與CCL漲價，營收動能延續」。
只輸出 JSON 陣列：[{"name":"題材名","codes":["代碼1","代碼2"],"desc":"一句話說明今日該族群表現與具體催化因素(35字內)"}]
不要其他文字、不要markdown框。codes只放下方有的代碼，每組至少1檔。
成交值前20：
${top50.slice(0,20).map(s=>`${s.code}(${s.name}) ${s.chg>0?'+':''}${s.chg}%`).join('\n')}`;

    // 每檔題材標籤
    const tagPrompt = `為以下台股個股各標一個「最貼切的中文題材標籤」(3-6字，如：晶圓代工、IC設計、記憶體、PCB載板、銅箔基板、被動元件、面板、封測、散熱、矽智財、AI伺服器、金控、光學鏡頭、網通、軍工、生技、ETF 等)。
只輸出JSON物件 {"代碼":"標籤",...}，不要其他文字、不要markdown框。
個股：${top50.map(s=>`${s.code}(${s.name})`).join('、')}`;

    const themeRaw = await callGemini(themePrompt);
    await new Promise(res => setTimeout(res, 4000));
    const tagRaw = await callGemini(tagPrompt);
    await new Promise(res => setTimeout(res, 4000));

    // 解析題材卡片 + 算族群漲跌幅
    let themeCards = [];
    const arr = parseGeminiJson(themeRaw);
    if (Array.isArray(arr)) {
      const chgMap = {}; top50.forEach(s => { chgMap[s.code] = s.chg; });
      themeCards = arr.map(t => {
        const codes = (t.codes || []).filter(c => chgMap[c] !== undefined);
        const avgChg = codes.length ? codes.reduce((sum, c) => sum + (chgMap[c] || 0), 0) / codes.length : 0;
        return { name: t.name || '', codes, desc: t.desc || '', chg: Math.round(avgChg * 100) / 100 };
      }).filter(t => t.name && t.codes.length);
    }
    const tags = parseGeminiJson(tagRaw) || {};

    // ── 第四批：市場焦點雙欄（Gemini + Google 搜尋查台股當天大盤大事 + 即將到來）──
    let marketFocus = { summary: '', happened: [], upcoming: [] };
    const top10txt = top50.slice(0, 10).map(s => `${s.code}(${s.name}) ${s.chg>0?'+':''}${s.chg}%`).join('\n');
    const focusPrompt = `你是專業台股財經記者，用繁體中文、台灣投資人口吻。請用 Google 搜尋查「台股最近一個交易日(${date})的大盤盤勢與重大事件」，以及「接下來幾天即將發生的重要事件」。參考當天成交值前10名：
${top10txt}

請輸出一個 JSON 物件，格式如下：
{
  "summary": "一段完整的盤勢總結(120-160字，像財經晨報的開場：先講加權指數漲跌點數與收盤點位、成交量，再講今天資金主軸與領漲領跌族群，最後點出外資/投信動向與市場故事線。要寫成通順的一整段，不是條列)",
  "happened": [
    {"title": "已發生事件標題(20字內，點出主角公司或族群)", "desc": "事件說明(60-80字，要有來龍去脈、數字、為何影響股價)", "date": "事件日期如6/28或今天"}
  ],
  "upcoming": [
    {"title": "即將到來事件標題(20字內)", "desc": "事件說明(60-80字，具體說明是什麼事、預期影響哪些族群)", "date": "預計日期如7/1或本週四"}
  ]
}
寫作要求（很重要，這決定內容品質）：
1. summary 要寫得完整詳盡（120-160字），像專業財經媒體的盤後總評，把今天台股的故事說清楚（指數點數、成交量、資金流向、領漲領跌族群、外資投信動向、市場主軸題材）。
2. happened 列「5 則」最近已經發生的台股重大事件，必須用 Google 搜尋查到真實近期新聞。每則 desc 要寫 60-80 字、有來龍去脈：點名哪家公司或族群、發生什麼（財報數字、法說會結論、外資買賣超金額、漲價幅度、訂單金額、分析師調目標價到多少、MSCI調整、政策等），並說明為何影響股價。例如「台積電法說會上調全年營收展望至中段30%成長，並宣布擴大資本支出，帶動上游設備與CoWoS供應鏈走強」這種具體寫法，不要寫「電子股上漲」這種空泛句。
3. upcoming 列「5 則」接下來幾天即將發生的具體事件（即將召開的法說會、即將公布的月營收、即將出爐的經濟數據、除權息、產業會議、政策議程等），每則 desc 也寫 60-80 字、說明預期影響。
4. 優先寫有明確主角、能解釋漲跌的事件。查不到的不要硬湊空泛句，但盡量湊滿5則。全部繁體中文。只輸出 JSON 物件，不要其他文字、不要 markdown 框。`;

    const focusRaw = await callGemini(focusPrompt, true);   // true = 開 Google 搜尋
    const focusObj = parseGeminiJson(focusRaw);
    if (focusObj && typeof focusObj === 'object') {
      marketFocus = {
        summary: typeof focusObj.summary === 'string' ? focusObj.summary : '',
        happened: Array.isArray(focusObj.happened) ? focusObj.happened.slice(0, 5).map(e => ({
          title: String(e.title || ''), desc: String(e.desc || ''), date: String(e.date || ''),
        })) : [],
        upcoming: Array.isArray(focusObj.upcoming) ? focusObj.upcoming.slice(0, 5).map(e => ({
          title: String(e.title || ''), desc: String(e.desc || ''), date: String(e.date || ''),
        })) : [],
      };
    }
    await new Promise(res => setTimeout(res, 4000));

    // ── 第三批：新進榜「發生了什麼」（Gemini + Google 搜尋查台股個股即時事件）──
    const newcomers = top50.filter(s => s.isNew);
    let newcomerCards = [];
    if (newcomers.length) {
      const ncList = newcomers.map(s => `${s.code}(${s.name}) 漲跌${s.chg>0?'+':''}${s.chg}%`).join('\n');
      const ncPrompt = `你是專業台股財經記者，用繁體中文、台灣投資人口吻。以下台股個股今天首次衝進成交值前50名、爆出大量。請用 Google 搜尋查出每一檔「最近這幾天股價為什麼大漲或大跌、為什麼爆量」的具體新聞原因。
要查的方向：法說會、月營收數字、外資投信買賣超、漲價題材、大客戶訂單、分析師調目標價、產業利多利空、政策、得標等「近期具體事件」。不要查除權息或股利這種例行資料。
每檔寫一句話，要「具體」：點出是什麼事件、有數字或對象就寫出來（例如「打入某大廠AI伺服器供應鏈、訂單能見度到明年」「外資連三買、調升目標價」），40字內，繁體中文。
若真的查不到近期具體新聞，才寫「近期無明確個股消息，可能受族群輪動帶動」。
輸出格式：只輸出一個 JSON 陣列，每個元素是 {"code":"代碼","event":"一句話原因字串"}。event 必須是純文字字串、不可以是物件或陣列。不要輸出 JSON 以外的任何文字。
個股清單：
${ncList}`;
      const ncRaw = await callGemini(ncPrompt, true);   // true = 開 Google 搜尋
      const ncArr = parseGeminiJson(ncRaw);
      const eventMap = {};
      if (Array.isArray(ncArr)) ncArr.forEach(x => {
        if (x.code) {
          let ev = x.event;
          if (typeof ev !== 'string') ev = '';
          eventMap[x.code] = ev;
        }
      });
      newcomerCards = newcomers.map(s => ({
        code: s.code, name: s.name, chg: s.chg,
        tag: tags[s.code] || '',
        event: eventMap[s.code] || '近期無明確個股消息，可能受族群輪動帶動。',
      }));
    }

    // 429 保護：生成失敗（空）時保留舊資料
    const prevAnalysis = (await kvGet("tw_analysis")) || {};
    const focusOk = marketFocus.summary || marketFocus.happened.length || marketFocus.upcoming.length;
    const finalMarketFocus = focusOk ? marketFocus : (prevAnalysis.marketFocus || marketFocus);
    const finalThemeCards = themeCards.length ? themeCards : (prevAnalysis.themeCards || []);
    const finalTags = Object.keys(tags).length ? tags : (prevAnalysis.tags || {});
    const ncHasRealEvent = newcomerCards.some(c => c.event && !c.event.includes('無明確個股消息'));
    const prevNc = prevAnalysis.newcomerCards || [];
    const prevNcHasReal = prevNc.some(c => c.event && !c.event.includes('無明確個股消息'));
    const sameNcCodes = newcomerCards.length === prevNc.length &&
      newcomerCards.every(c => prevNc.find(p => p.code === c.code));
    const finalNewcomerCards = (!ncHasRealEvent && prevNcHasReal && sameNcCodes) ? prevNc : newcomerCards;

    const analysis = { ok: true, date, updatedAt: Date.now(), marketFocus: finalMarketFocus, themeCards: finalThemeCards, tags: finalTags, newcomerCards: finalNewcomerCards };
    await kvPut("tw_analysis", analysis, 86400 * 3);
    console.log(`台股AI分析：焦點(已發生${finalMarketFocus.happened.length}/即將${finalMarketFocus.upcoming.length})、題材${finalThemeCards.length}組、標籤${Object.keys(finalTags).length}檔、新進榜${finalNewcomerCards.length}檔`);

    // ── 第五批：存當天完整快照（top50 + analysis 合一）+ 維護日期清單 ──
    try {
      const top50full = await kvGet("tw_top50");
      const snapshot = {
        ok: true, date,
        data: (top50full && top50full.data) ? top50full.data : top50,
        updatedAt: top50full ? top50full.updatedAt : Date.now(),
        marketFocus: finalMarketFocus, themeCards: finalThemeCards, tags: finalTags, newcomerCards: finalNewcomerCards,
      };
      await kvPut(`tw_snapshot_${date}`, snapshot, 86400 * 60);   // 快照保留60天
      let dates = (await kvGet("tw_snapshot_dates")) || [];
      if (!Array.isArray(dates)) dates = [];
      if (!dates.includes(date)) dates.unshift(date);
      dates.sort((a, b) => b.localeCompare(a));
      dates = dates.slice(0, 60);
      await kvPut("tw_snapshot_dates", dates, 86400 * 60);
      console.log(`台股快照已存：tw_snapshot_${date}，目前共${dates.length}天歷史`);
    } catch (e) {
      console.error("存台股快照失敗:", e.message);
    }
  } catch (e) {
    console.error("buildTwAnalysis error:", e.message);
  }
}

app.get("/api/tw-analysis", async (req, res) => {
  try {
    const cached = await kvGet("tw_analysis");
    if (cached && cached.ok) return res.json(cached);
    res.json({ ok: false, themeCards: [], tags: {} });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, themeCards: [], tags: {} });
  }
});

// 第五批：台股可選歷史日期清單
app.get("/api/tw-dates", async (req, res) => {
  try {
    let dates = (await kvGet("tw_snapshot_dates")) || [];
    if (!Array.isArray(dates)) dates = [];
    if (!dates.length) {
      const cur = await kvGet("tw_top50");
      if (cur && cur.date) dates = [cur.date];
    }
    res.json({ ok: true, dates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, dates: [] });
  }
});

// 第五批：讀台股某一天的完整快照
app.get("/api/tw-snapshot", async (req, res) => {
  try {
    const date = (req.query.date || "").slice(0, 10);
    if (!date) return res.status(400).json({ ok: false, error: "缺少 date 參數" });
    const snap = await kvGet(`tw_snapshot_${date}`);
    if (snap && snap.ok) return res.json(snap);
    res.status(404).json({ ok: false, error: `查無 ${date} 的快照` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 全天每 5 分鐘更新熱門族群新聞（含盤中盤後；有新聞才寫 KV）
cron.schedule("*/5 * * * *", async () => {
  await updateSectorNews();
  await updateTwNews();   // 台股新聞（鉅亨）：搬自 Worker，每5分鐘抓→有新才寫 KV
});

// 台股 Top50 cron：台股下午1:30收盤，但 STOCK_DAY_ALL 全市場彙總約下午5點才更新完整
// 17:00(UTC 09:00)抓當天完整收盤 + 18:00(UTC 10:00)補跑一次（雙保險）
cron.schedule("0 9 * * *", async () => {   // 台北 17:00 (UTC 09:00)
  try {
    const r = await buildTwTop50();
    if (r && r.ok && r.data && r.data.length) await buildTwAnalysis(r.data, r.date);
    console.log(`台股 cron(17:00) date=${r && r.date}`);
  } catch (e) { console.error("台股 cron(17:00) error:", e.message); }
});
cron.schedule("0 10 * * *", async () => {   // 台北 18:00 補跑
  try {
    const r = await buildTwTop50();
    if (r && r.ok && r.data && r.data.length) await buildTwAnalysis(r.data, r.date);
    console.log(`台股 cron(18:00補) date=${r && r.date}`);
  } catch (e) { console.error("台股 cron(18:00補) error:", e.message); }
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

  // 砍掉「純股名」那組（同名詞雜訊大本營，如「全新」會撈到全新EP/全新登台）。
  // 改用「股名 股號」+「純股號」兩組，都要求含股號，雜訊在搜尋階段就被擋掉。
  // name 為空（純股號查詢）時，第一組為空字串被濾掉，等同只搜股號。
  const searches = [...new Set(
    [name && code ? `${name} ${code}` : '', code].filter(q => q.trim())
  )];
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

  const sorted = uniqueNews(allItems).sort((a, b) => new Date(b.pub) - new Date(a.pub)).slice(0, 30);
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

// ══════════════════════════════════════════════════════════
//  美股成交值 Top50（Polygon）— 第一批：行情+在榜天數+排名變化+NEW
//  每天台北 13:30(UTC5:30) cron 抓 Polygon 前一交易日收盤 → 算榜 → 寫 KV
// ══════════════════════════════════════════════════════════
const POLYGON_KEY = process.env.POLYGON_KEY;
const POLY_BASE   = "https://api.polygon.io";
let _csCache = { date: "", set: null, names: null };
const NON_STOCK_RE = /(Acquisition Corp|\bNotes\b|Preferred|Depositary|Warrant|\bUnits?\b|\bRight\b|Subordinated|Debenture)/i;

// 推算「最近一個已收盤的美股交易日」(回傳 YYYY-MM-DD)
// 關鍵：美股收盤=美東16:00=UTC約20:00-21:00(夏令)/21:00-22:00(冬令)
// 所以要先判斷「UTC 現在這天的美股盤收了沒」：
//   - UTC 已過 22:00 → 今天的盤已收，最近交易日 = 今天(offsetBase=0)
//   - UTC 還沒到 22:00 → 今天盤還沒收(或還沒開)，最近交易日 = 昨天(offsetBase=1)
// 再往前跳過週末。offsetDays 額外再往前推幾天(抓前一日對照用)。
function usPrevTradingDate(offsetDays = 0) {
  const now = new Date();
  // 美股收盤後才算「今天已收」，用 UTC 22:00 當保險分界(冬令美股也收完了)
  const marketClosedToday = now.getUTCHours() >= 22;
  const offsetBase = marketClosedToday ? 0 : 1;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetBase - offsetDays);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchUsStockWhitelist() {
  const today = new Date().toISOString().slice(0, 10);
  if (_csCache.date === today && _csCache.set) return _csCache;
  const set = new Set(); const names = {};
  let url = `${POLY_BASE}/v3/reference/tickers?type=CS&market=stocks&active=true&limit=1000&apiKey=${POLYGON_KEY}`;
  let pages = 0;
  while (url && pages < 8) {
    const r = await fetch(url);
    if (!r.ok) break;
    const j = await r.json();
    for (const t of (j.results || [])) {
      const name = t.name || "";
      if (NON_STOCK_RE.test(name)) continue;
      set.add(t.ticker); names[t.ticker] = name;
    }
    pages++;
    url = j.next_url ? `${j.next_url}&apiKey=${POLYGON_KEY}` : null;
  }
  _csCache = { date: today, set, names };
  console.log(`美股白名單(type=CS)：${set.size} 檔`);
  return _csCache;
}

async function fetchGroupedDaily(date) {
  const url = `${POLY_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${POLYGON_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status, count: 0, map: new Map() };
  const j = await r.json();
  const map = new Map();
  for (const row of (j.results || [])) map.set(row.T, row);
  return { ok: true, count: (j.results || []).length, map };
}

// 從某個 YYYY-MM-DD 往前推 N 個「交易日」(跳過週末)
function prevTradingDayFrom(dateStr, n = 1) {
  const d = new Date(dateStr + "T12:00:00Z");
  for (let k = 0; k < n; k++) {
    d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

async function buildUsTop50() {
  if (!POLYGON_KEY) return { ok: false, error: "POLYGON_KEY 未設定", data: [] };
  try {
    const wl = await fetchUsStockWhitelist();
    let date = usPrevTradingDate(0), grouped = null;   // 0 = 最近一個已收盤交易日
    for (let i = 0; i < 4; i++) {
      grouped = await fetchGroupedDaily(date);
      if (grouped.ok && grouped.count > 100) break;
      date = usPrevTradingDate(i + 1);                  // 抓不到就再往前一天
    }
    if (!grouped || !grouped.ok || grouped.count <= 100) return { ok: false, error: "Polygon grouped 無資料", data: [] };

    const prevDateGuess = prevTradingDayFrom(date, 1);  // 從主抓日往前一個交易日(週一也不會重疊)
    const prev = await fetchGroupedDaily(prevDateGuess);

    const rows = [];
    for (const [ticker, d] of grouped.map) {
      if (!wl.set.has(ticker)) continue;
      const close = d.c || 0, vol = d.v || 0, vwap = d.vw || close;
      if (close <= 0 || vol <= 0) continue;
      let chgPct = 0;
      const p = prev.ok ? prev.map.get(ticker) : null;
      if (p && p.c > 0) chgPct = ((close - p.c) / p.c) * 100;
      rows.push({
        code: ticker, name: wl.names[ticker] || ticker,
        price: Math.round(close * 100) / 100,
        chg: Math.round(chgPct * 100) / 100,
        dollarVol: Math.round(vwap * vol), vol,
      });
    }
    rows.sort((a, b) => b.dollarVol - a.dollarVol);
    let top50 = rows.slice(0, 50).map((s, i) => ({ rank: i + 1, ...s }));

    // ── 在榜天數 + 排名變化 + NEW ──
    // 新進榜判定：用「上一個交易日的 top50 快照」比對——今天有、昨天快照沒有的 = 新進榜
    // 快照只在「日期變了」才更新（避免同一天 rebuild 多次自己跟自己比，導致新進榜永遠空）
    const snap = (await kvGet("us_prev_top50")) || { date: "", codes: [] };
    const prevCodes = new Set(snap.codes || []);
    const isFirstRun = !snap.date;                  // 從沒有快照（第一次跑）
    const hist = (await kvGet("us_history")) || {};
    const newHist = {};
    top50 = top50.map(s => {
      const h = hist[s.code];
      // 新進榜：昨天快照沒有這檔（且非第一次跑，第一次無對照基準不標NEW）
      const isNew = !isFirstRun && !prevCodes.has(s.code);
      const days = h ? (h.days || 1) + 1 : 1;
      const rankChange = h && h.lastRank ? (h.lastRank - s.rank) : 0;
      newHist[s.code] = { days, lastRank: s.rank, firstDate: h?.firstDate || date };
      return { ...s, days, isNew, rankChange };
    });
    await kvPut("us_history", newHist, 86400 * 30);

    // 更新「昨天快照」：只有當 KV 裡的快照日期 ≠ 今天，才把今天存成新快照
    // （這樣同一天 rebuild 多次，快照維持「上一個交易日」，新進榜判定才穩定）
    if (snap.date !== date) {
      await kvPut("us_prev_top50", { date, codes: top50.map(s => s.code) }, 86400 * 7);
    }

    const result = { ok: true, date, count: top50.length, updatedAt: Date.now(), data: top50 };
    await kvPut("us_top50", result, 86400 * 3);
    console.log(`美股Top50：date=${date} 共${top50.length}檔，新進榜${top50.filter(s=>s.isNew).length}檔`);
    return result;
  } catch (e) {
    console.error("buildUsTop50 error:", e.message);
    return { ok: false, error: e.message, data: [] };
  }
}

app.get("/api/us-top50", async (req, res) => {
  try {
    const cached = await kvGet("us_top50");
    if (cached && cached.ok && Array.isArray(cached.data) && cached.data.length) return res.json(cached);
    const fresh = await buildUsTop50();
    if (!fresh.ok) return res.status(502).json(fresh);
    res.json(fresh);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, data: [] });
  }
});

// 手動觸發（測試用，非阻塞）
app.get("/api/us-rebuild", async (req, res) => {
  try {
    const r = await buildUsTop50();
    if (!r.ok) return res.status(502).json(r);
    buildUsAnalysis(r.data, r.date).catch(e => console.error("background analysis:", e.message));
    res.json({ ok: true, date: r.date, count: r.count, note: "行情已更新，AI題材分析背景生成中" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 測試用：把「昨天快照」故意設成「今天榜去掉後10檔」，讓那10檔變新進榜（驗證新進榜功能）
app.get("/api/us-test-newcomers", async (req, res) => {
  try {
    const cur = await kvGet("us_top50");
    if (!cur || !cur.data) return res.json({ ok: false, error: "尚無 us_top50 資料，請先 us-rebuild" });
    const codes = cur.data.map(s => s.code).slice(0, 40);   // 假裝昨天只有前40檔
    // date 設成跟今天一樣，這樣 rebuild 時 snap.date===date 不會覆蓋掉這個測試快照
    await kvPut("us_prev_top50", { date: cur.date, codes }, 86400 * 7);
    res.json({ ok: true, note: "已設測試快照（昨天=前40檔）。現在打 /api/us-rebuild，第41-50名會變新進榜" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 美股 AI 分析（第二批：發動題材卡片 + 每檔題材標籤）──
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = "gemini-2.5-flash";

async function callGemini(prompt, useSearch = false, retries = 3) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (useSearch) body.tools = [{ google_search: {} }];   // 接 Google 搜尋（第三四批用）
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429) { await new Promise(res => setTimeout(res, 6000 * (attempt + 1))); continue; }
      if (!r.ok) { console.error("Gemini HTTP", r.status); return null; }
      const j = await r.json();
      const parts = j?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return null;
      // 合併所有 parts 的 text（Google搜尋時回傳會拆成多個 part）
      const text = parts.map(p => p?.text || '').join('\n').trim();
      return text || null;
    } catch (e) { console.error("callGemini error:", e.message); return null; }
  }
  return null;
}

function parseGeminiJson(raw) {
  if (!raw) return null;
  let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  // 直接解析
  try { return JSON.parse(s); } catch (e) {}
  // 從混雜文字中抽出第一個 JSON 陣列或物件（Google搜尋回傳常夾雜說明文字）
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch (e) {} }
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch (e) {} }
  console.error("JSON解析失敗:", s.slice(0, 100));
  return null;
}

async function buildUsAnalysis(top50, date) {
  if (!GEMINI_API_KEY) { console.log("美股AI：GEMINI_API_KEY 未設定，跳過"); return; }
  try {
    // 發動題材卡片（JSON：題材名+成員代碼+說明）
    const themePrompt = `你是專業美股財經記者，用繁體中文、台灣投資人口吻。根據以下美股${date}成交值前20名，歸納成「今日發動題材／族群」，依資金熱度排序。
重要規則：
1. 必須列出 4-6 組題材（不要只列1-2組），把前20名的個股盡量都歸類進去，不管當天漲或跌都要分類（成交值大本身就代表資金關注，跌的也是題材）。
2. 常見題材如：AI半導體、記憶體、AI晶片、雲端服務、電動車、太空、金融、減肥藥GLP-1、半導體設備、串流媒體、社群媒體、電商等。
3. desc 要「具體」：點出該族群今天為什麼動（催化因素：AI需求、財報、訂單、政策、資金輪動等），不要只寫「表現強勁」這種空泛句。例如「AI 伺服器需求帶動上游半導體設備訂單與營收預期」這種寫法。
只輸出 JSON 陣列：[{"name":"題材名","codes":["代碼1","代碼2"],"desc":"一句話說明今日該族群表現與具體催化因素(35字內)"}]
不要其他文字、不要markdown框。codes只放下方有的代碼，每組至少1檔。
成交值前20：
${top50.slice(0,20).map(s=>`${s.code}(${s.name}) ${s.chg>0?'+':''}${s.chg}%`).join('\n')}`;

    // 每檔題材標籤（JSON：代碼→標籤）
    const tagPrompt = `為以下美股個股各標一個「最貼切的中文題材標籤」(4-8字，如：AI晶片、記憶體、電動車、太空、雲端服務、減肥藥GLP-1、比特幣/加密、儲存裝置、消費性電子、半導體設備、串流媒體、航空、晶圓代工、社群媒體、支付服務 等)。
只輸出JSON物件 {"代碼":"標籤",...}，不要其他文字、不要markdown框。
個股：${top50.map(s=>`${s.code}(${s.name})`).join('、')}`;

    const themeRaw = await callGemini(themePrompt);
    await new Promise(res => setTimeout(res, 4000));
    const tagRaw = await callGemini(tagPrompt);
    await new Promise(res => setTimeout(res, 4000));

    // 解析題材卡片 + 算族群漲跌幅
    let themeCards = [];
    const arr = parseGeminiJson(themeRaw);
    if (Array.isArray(arr)) {
      const chgMap = {}; top50.forEach(s => { chgMap[s.code] = s.chg; });
      themeCards = arr.map(t => {
        const codes = (t.codes || []).filter(c => chgMap[c] !== undefined);
        const avgChg = codes.length ? codes.reduce((sum, c) => sum + (chgMap[c] || 0), 0) / codes.length : 0;
        return { name: t.name || '', codes, desc: t.desc || '', chg: Math.round(avgChg * 100) / 100 };
      }).filter(t => t.name && t.codes.length);
    }
    const tags = parseGeminiJson(tagRaw) || {};

    // ── 第四批：市場焦點雙欄（Gemini + Google搜尋查當天美股大事 + 即將到來）──
    await new Promise(res => setTimeout(res, 4000));
    let marketFocus = { summary: '', happened: [], upcoming: [] };
    const top10txt = top50.slice(0, 10).map(s => `${s.code}(${s.name}) ${s.chg>0?'+':''}${s.chg}%`).join('\n');
    const focusPrompt = `你是專業美股財經記者，用繁體中文、台灣投資人口吻。請用 Google 搜尋查「美股最近一個交易日(${date})的整體盤勢與重大事件」，以及「接下來幾天即將發生的重要事件」。參考當天成交值前10名：
${top10txt}

請輸出一個 JSON 物件，格式如下：
{
  "summary": "一段完整的盤勢總結(120-160字，像財經晨報的開場：先講三大指數(道瓊/標普/那斯達克)漲跌與費半，再講今天資金主軸與領漲領跌族群，最後點出市場氛圍與故事線。要寫成通順的一整段，不是條列)",
  "happened": [
    {"title": "已發生事件標題(20字內，要點出主角公司或主題)", "desc": "事件說明(60-80字，要有來龍去脈、數字、為何影響股價)", "date": "事件日期如6/25或今天"}
  ],
  "upcoming": [
    {"title": "即將到來事件標題(20字內)", "desc": "事件說明(60-80字，具體說明是什麼事、預期影響哪些族群)", "date": "預計日期如6/27或本週四"}
  ]
}
寫作要求（很重要，這決定內容品質）：
1. summary 要寫得完整詳盡（120-160字），像專業財經媒體的盤後總評，把今天美股的故事說清楚（三大指數與費半漲跌、資金流向、領漲領跌族群、市場氛圍、主軸題材）。
2. happened 列「5 則」最近已經發生的美股重大事件，必須用 Google 搜尋查到真實近期新聞。每則 desc 要寫 60-80 字、有來龍去脈：點名哪家公司或族群、發生什麼事（財報數字、併購對象與金額、分析師調評幅度與目標價、納入/剔除指數、產品發表、政策、訂單金額等），並說明為何影響股價。例如「Nvidia 公布財報營收年增超過1倍、資料中心業務創高，並上調下季財測，帶動整個 AI 半導體鏈走強」這種具體寫法，不要寫「科技股上漲」這種空泛句。
3. upcoming 列「5 則」接下來幾天即將發生的具體事件（即將公布的某公司財報、即將召開的會議名稱、即將出爐的經濟數據名稱與日期、Fed 會議等），每則 desc 也寫 60-80 字、說明預期影響。
4. 優先寫有明確主角、能解釋漲跌的事件。查不到的不要硬湊空泛句，但盡量湊滿5則。全部繁體中文。只輸出 JSON 物件，不要其他文字、不要 markdown 框。`;

    const focusRaw = await callGemini(focusPrompt, true);   // true = 開 Google 搜尋
    const focusObj = parseGeminiJson(focusRaw);
    if (focusObj && typeof focusObj === 'object') {
      marketFocus = {
        summary: typeof focusObj.summary === 'string' ? focusObj.summary : '',
        happened: Array.isArray(focusObj.happened) ? focusObj.happened.slice(0, 5).map(e => ({
          title: String(e.title || ''), desc: String(e.desc || ''), date: String(e.date || ''),
        })) : [],
        upcoming: Array.isArray(focusObj.upcoming) ? focusObj.upcoming.slice(0, 5).map(e => ({
          title: String(e.title || ''), desc: String(e.desc || ''), date: String(e.date || ''),
        })) : [],
      };
    }

    // ── 第三批：新進榜「發生了什麼」（Gemini + Google搜尋查即時事件）──
    const newcomers = top50.filter(s => s.isNew);
    let newcomerCards = [];
    if (newcomers.length) {
      const ncList = newcomers.map(s => `${s.code}(${s.name}) 漲跌${s.chg>0?'+':''}${s.chg}%`).join('\n');
      const ncPrompt = `你是專業美股財經記者，用繁體中文、台灣投資人口吻。以下個股今天首次衝進美股成交值前50名、爆出大量。請用 Google 搜尋查出每一檔「最近這幾天股價為什麼大漲或大跌、為什麼爆量」的具體新聞原因。
要查的方向：財報數字、併購對象、分析師調評(誰調、調到多少)、產品或技術發表、大客戶訂單(金額)、產業利多利空、政策法規、指數調整、機構買賣等「近期具體事件」。不要查股票分割或股息這種無關的歷史資料。
每檔寫一句話，要「具體」：點出是什麼事件、有數字或對象就寫出來（例如「宣布庫藏股回購並啟動比特幣變現計畫」「獲分析師重申買進、目標價上調」「擴大與某大廠 AI 合作」），40字內，繁體中文。
若真的查不到近期具體新聞，才寫「近期無明確個股消息，可能受族群輪動帶動」。
輸出格式：只輸出一個 JSON 陣列，每個元素是 {"code":"代碼","event":"一句話原因字串"}。event 必須是純文字字串、不可以是物件或陣列。不要輸出 JSON 以外的任何文字。
個股清單：
${ncList}`;
      const ncRaw = await callGemini(ncPrompt, true);   // true = 開 Google 搜尋
      const ncArr = parseGeminiJson(ncRaw);
      const eventMap = {};
      if (Array.isArray(ncArr)) ncArr.forEach(x => {
        if (x.code) {
          // event 強制轉成字串（防 Gemini 回成物件/陣列）
          let ev = x.event;
          if (typeof ev !== 'string') ev = '';
          eventMap[x.code] = ev;
        }
      });
      newcomerCards = newcomers.map(s => ({
        code: s.code, name: s.name, chg: s.chg,
        tag: tags[s.code] || '',
        event: eventMap[s.code] || '近期無明確個股消息，可能受族群輪動帶動。',
      }));
    }

    // ── 429 保護：若這次某部分生成失敗（空），保留上次的舊資料，不要用空的覆蓋 ──
    const prevAnalysis = (await kvGet("us_analysis")) || {};
    const focusOk = marketFocus.summary || marketFocus.happened.length || marketFocus.upcoming.length;
    const finalMarketFocus = focusOk ? marketFocus : (prevAnalysis.marketFocus || marketFocus);
    const finalThemeCards = themeCards.length ? themeCards : (prevAnalysis.themeCards || []);
    const finalTags = Object.keys(tags).length ? tags : (prevAnalysis.tags || {});
    // 新進榜：若這次 event 全是 fallback（Google搜尋失敗），且上次有真資料，保留上次的
    const ncHasRealEvent = newcomerCards.some(c => c.event && !c.event.includes('無明確個股消息'));
    const prevNc = prevAnalysis.newcomerCards || [];
    const prevNcHasReal = prevNc.some(c => c.event && !c.event.includes('無明確個股消息'));
    const sameNcCodes = newcomerCards.length === prevNc.length &&
      newcomerCards.every(c => prevNc.find(p => p.code === c.code));
    const finalNewcomerCards = (!ncHasRealEvent && prevNcHasReal && sameNcCodes) ? prevNc : newcomerCards;

    const analysis = { ok: true, date, updatedAt: Date.now(), marketFocus: finalMarketFocus, themeCards: finalThemeCards, tags: finalTags, newcomerCards: finalNewcomerCards };
    await kvPut("us_analysis", analysis, 86400 * 3);
    const keptParts = [];
    if (!focusOk && finalMarketFocus !== marketFocus) keptParts.push('焦點');
    if (!themeCards.length && finalThemeCards.length) keptParts.push('題材');
    if (!Object.keys(tags).length && Object.keys(finalTags).length) keptParts.push('標籤');
    console.log(`美股AI分析：焦點${finalMarketFocus.happened.length}/${finalMarketFocus.upcoming.length}、題材${finalThemeCards.length}組、標籤${Object.keys(finalTags).length}檔、新進榜${finalNewcomerCards.length}檔${keptParts.length?'（429保護:保留舊'+keptParts.join('/')+'）':''}`);

    // 用 final 版本存快照
    const themeCardsForSnap = finalThemeCards, tagsForSnap = finalTags, marketFocusForSnap = finalMarketFocus, newcomerCardsForSnap = finalNewcomerCards;

    // ── 第五批：存當天完整快照（top50 + analysis 合一）+ 維護日期清單 ──
    try {
      const top50full = await kvGet("us_top50");
      const snapshot = {
        ok: true, date,
        data: (top50full && top50full.data) ? top50full.data : top50,
        updatedAt: top50full ? top50full.updatedAt : Date.now(),
        marketFocus: marketFocusForSnap, themeCards: themeCardsForSnap, tags: tagsForSnap, newcomerCards: newcomerCardsForSnap,
      };
      await kvPut(`us_snapshot_${date}`, snapshot, 86400 * 60);   // 快照保留60天
      // 更新日期清單（最新在前、去重、最多保留60筆）
      let dates = (await kvGet("us_snapshot_dates")) || [];
      if (!Array.isArray(dates)) dates = [];
      if (!dates.includes(date)) dates.unshift(date);
      dates.sort((a, b) => b.localeCompare(a));      // 日期字串降冪=最新在前
      dates = dates.slice(0, 60);
      await kvPut("us_snapshot_dates", dates, 86400 * 60);
      console.log(`美股快照已存：us_snapshot_${date}，目前共${dates.length}天歷史`);
    } catch (e) {
      console.error("存美股快照失敗:", e.message);
    }
  } catch (e) {
    console.error("buildUsAnalysis error:", e.message);
  }
}

app.get("/api/us-analysis", async (req, res) => {
  try {
    const cached = await kvGet("us_analysis");
    if (cached && cached.ok) return res.json(cached);
    res.json({ ok: false, themeCards: [], tags: {} });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 第五批：可選的歷史日期清單（最新在前）
app.get("/api/us-dates", async (req, res) => {
  try {
    let dates = (await kvGet("us_snapshot_dates")) || [];
    if (!Array.isArray(dates)) dates = [];
    // 保險：若清單空但有當前資料，至少回今天那天
    if (!dates.length) {
      const cur = await kvGet("us_top50");
      if (cur && cur.date) dates = [cur.date];
    }
    res.json({ ok: true, dates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, dates: [] });
  }
});

// 第五批：讀某一天的完整快照（top50 + 分析合一）
app.get("/api/us-snapshot", async (req, res) => {
  try {
    const date = (req.query.date || "").slice(0, 10);
    if (!date) return res.status(400).json({ ok: false, error: "缺少 date 參數" });
    const snap = await kvGet(`us_snapshot_${date}`);
    if (snap && snap.ok) return res.json(snap);
    res.status(404).json({ ok: false, error: `查無 ${date} 的快照` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// cron：每天台北13:00抓美股（UTC 05:00）。實測 Polygon 免費版當天資料約台北下午1點 ready
// 1點半(UTC 05:30)再補跑一次：若1點時資料還沒完全好，補抓當天最新（雙保險）
async function runUsCron(label) {
  try {
    const r = await buildUsTop50();
    if (r && r.ok && r.data && r.data.length) await buildUsAnalysis(r.data, r.date);
    console.log(`美股 cron(${label}) 完成：date=${r && r.date}`);
  } catch (e) {
    console.error(`美股 cron(${label}) error:`, e.message);
  }
}
cron.schedule("0 5 * * *", () => runUsCron("13:00"));    // 台北下午1點
cron.schedule("30 5 * * *", () => runUsCron("13:30補"));  // 台北下午1點半補跑

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await updateSectorNews();
  await updateTwNews();   // 啟動先抓一次台股新聞，不用等第一個5分鐘
});
