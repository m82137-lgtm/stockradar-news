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
      close,
      chgPct,
      vol: Math.round(volume / 1000),
      tradeValue,
    });
  }
  return { ok: true, status, date: json[0]?.Date || null, count: data.length, data };
}

// 全天每 5 分鐘更新熱門族群新聞（含盤中盤後；有新聞才寫 KV）
cron.schedule("*/5 * * * *", async () => {
  await updateSectorNews();
  await updateTwNews();   // 台股新聞（鉅亨）：搬自 Worker，每5分鐘抓→有新才寫 KV
});

// 美股 Top50：每天台北 13:30（UTC 5:30）抓 Polygon 建榜→寫 KV
// （比照原版：免費源於美股收盤後隔日才穩，故下午抓前一交易日收盤）
cron.schedule("30 5 * * *", async () => {
  const r = await buildUsTop50();
  if (r && r.ok && r.data && r.data.length) {
    await buildUsAnalysis(r.data, r.date);   // 行情建好後接著生 Gemini 分析
  }
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
//  美股成交值 Top50（Polygon / Massive）
//  流程：① type=CS 撈個股白名單（快取一天）② grouped daily 撈全市場
//        ③ 只留白名單內的、濾掉 ETF/SPAC/特別股/債/權證
//        ④ 算成交金額(vw×v)、漲跌幅(撈前一交易日相減) → 排序取 Top50 → 寫 KV
//  每天台北 13:30 由 cron 觸發（美股前一交易日收盤；免費源收盤後隔日才穩，故下午抓）
// ══════════════════════════════════════════════════════════
const POLYGON_KEY = process.env.POLYGON_KEY;
const POLY_BASE   = "https://api.polygon.io";

// 個股白名單快取（避免每天翻 5-6 頁；存代碼 Set + 名稱對照）
let _csCache = { date: "", set: null, names: null };

// 名稱關鍵字：含這些字的剔除（SPAC/特別股/債/權證/單位等非營運個股）
const NON_STOCK_RE = /(Acquisition Corp|\bNotes\b|Preferred|Depositary|Warrant|\bUnits?\b|\bRight\b|Subordinated|Debenture)/i;

// 取「前一美股交易日」的日期字串(YYYY-MM-DD)，用 UTC 推算避開時區/換日誤差
function usPrevTradingDate(offsetDays = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  // 跳過週末（六=6、日=0）往前推到最近的平日
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 抓 type=CS 個股白名單（跟著 next_url 翻頁，全部撈完）
async function fetchUsStockWhitelist() {
  const today = new Date().toISOString().slice(0, 10);
  if (_csCache.date === today && _csCache.set) return _csCache;   // 當天已撈過，用快取

  const set = new Set();
  const names = {};
  let url = `${POLY_BASE}/v3/reference/tickers?type=CS&market=stocks&active=true&limit=1000&apiKey=${POLYGON_KEY}`;
  let pages = 0;
  while (url && pages < 8) {   // 上限8頁保險（普通股約5-6千檔）
    const r = await fetch(url);
    if (!r.ok) break;
    const j = await r.json();
    for (const t of (j.results || [])) {
      const name = t.name || "";
      if (NON_STOCK_RE.test(name)) continue;          // 濾掉 SPAC/特別股/債/權證
      set.add(t.ticker);
      names[t.ticker] = name;
    }
    pages++;
    url = j.next_url ? `${j.next_url}&apiKey=${POLYGON_KEY}` : null;
  }
  _csCache = { date: today, set, names };
  console.log(`美股白名單(type=CS)：${set.size} 檔，翻 ${pages} 頁`);
  return _csCache;
}

// 抓某日 grouped daily 全市場（回 Map: ticker -> {c,vw,v...}）
async function fetchGroupedDaily(date) {
  const url = `${POLY_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${POLYGON_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status, count: 0, map: new Map() };
  const j = await r.json();
  const map = new Map();
  for (const row of (j.results || [])) map.set(row.T, row);
  return { ok: true, count: (j.results || []).length, map };
}

// 主流程：算 Top50
async function buildUsTop50() {
  if (!POLYGON_KEY) return { ok: false, error: "POLYGON_KEY 未設定", data: [] };
  try {
    const wl = await fetchUsStockWhitelist();

    // 撈當天；若空(8點前/未打包)退一天，最多退4天找到有資料的盤
    let date = usPrevTradingDate(1), grouped = null;
    for (let i = 0; i < 4; i++) {
      grouped = await fetchGroupedDaily(date);
      if (grouped.ok && grouped.count > 100) break;
      date = usPrevTradingDate(i + 2);
    }
    if (!grouped || !grouped.ok || grouped.count <= 100) {
      return { ok: false, error: "Polygon grouped 無資料", data: [] };
    }

    // 前一交易日（算漲跌幅用）
    const prevDateGuess = usPrevTradingDate(2);
    const prev = await fetchGroupedDaily(prevDateGuess);

    // 組裝：只留白名單內的個股，算成交值與漲跌幅
    const rows = [];
    for (const [ticker, d] of grouped.map) {
      if (!wl.set.has(ticker)) continue;            // 非個股(ETF/SPAC等)跳過
      const close = d.c || 0;
      const vol   = d.v || 0;
      const vwap  = d.vw || close;
      if (close <= 0 || vol <= 0) continue;
      const dollarVol = vwap * vol;                 // 成交金額 = 成交均價 × 量
      let chgPct = 0;
      const p = prev.ok ? prev.map.get(ticker) : null;
      if (p && p.c > 0) chgPct = ((close - p.c) / p.c) * 100;
      rows.push({
        code: ticker,
        name: wl.names[ticker] || ticker,
        price: Math.round(close * 100) / 100,
        chg: Math.round(chgPct * 100) / 100,
        dollarVol: Math.round(dollarVol),
        vol,
      });
    }

    rows.sort((a, b) => b.dollarVol - a.dollarVol);
    const top50 = rows.slice(0, 50).map((s, i) => ({ rank: i + 1, ...s }));

    const result = { ok: true, date, count: top50.length, updatedAt: Date.now(), data: top50 };
    await kvPut("us_top50", result, 86400 * 3);     // 寫 KV，保留3天
    console.log(`美股Top50：date=${date} 共${top50.length}檔（白名單${wl.set.size}/全市場${grouped.count}）`);
    return result;
  } catch (e) {
    console.error("buildUsTop50 error:", e.message);
    return { ok: false, error: e.message, data: [] };
  }
}

// endpoint：前端 fetch。先讀 KV(快)，沒有才現抓
app.get("/api/us-top50", async (req, res) => {
  try {
    const cached = await kvGet("us_top50");
    if (cached && cached.ok && Array.isArray(cached.data) && cached.data.length) {
      return res.json(cached);
    }
    const fresh = await buildUsTop50();
    if (!fresh.ok) return res.status(502).json(fresh);
    res.json(fresh);
  } catch (e) {
    console.error("/api/us-top50 error:", e.message);
    res.status(500).json({ ok: false, error: e.message, data: [] });
  }
});

// ══════════════════════════════════════════════════════════
//  美股 AI 分析（Gemini）：市場焦點 / 新進榜雷達 / 發動題材
//  與行情解耦——行情先存好，分析失敗不影響表格顯示
// ══════════════════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = "gemini-2.5-flash";   // 現役正式版（2.0已於2026/3退役）；免費10 RPM / 1500 RPD

// 呼叫 Gemini，回純文字（失敗回 null，不拋例外）。撞 429 自動退避重試
async function callGemini(prompt, retries = 3) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 },   // 關閉thinking：生短分析不需要，省token避免截斷
          },
        }),
      });
      if (r.status === 429) {
        // 撞速率限制：退避等待後重試（6s、12s、18s…）
        const wait = 6000 * (attempt + 1);
        console.warn(`Gemini 429，第${attempt+1}次退避 ${wait/1000}s`);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) { console.error("Gemini HTTP", r.status); return null; }
      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? text.trim() : null;
    } catch (e) {
      console.error("callGemini error:", e.message);
      return null;
    }
  }
  console.error("Gemini 429 重試耗盡");
  return null;
}

// 抓某檔近期新聞（Polygon news，回 標題+摘要+情緒；失敗回空）
async function fetchTickerNews(code, limit = 3) {
  try {
    const url = `${POLY_BASE}/v2/reference/news?ticker=${code}&limit=${limit}&apiKey=${POLYGON_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map(n => {
      // 取這檔對應的情緒（Polygon 已標好利多/利空+理由）
      const ins = (n.insights || []).find(i => i.ticker === code);
      const senTxt = ins ? `[${ins.sentiment}] ${ins.sentiment_reasoning || ''}` : '';
      // 標題 + 摘要(截斷) + 情緒理由，組成一條餵 Gemini 的素材
      const desc = (n.description || '').slice(0, 200);
      return [n.title, desc, senTxt].filter(Boolean).join(' ｜ ');
    }).filter(Boolean);
  } catch { return []; }
}

// 主流程：算新進榜 + 抓新聞 + 呼叫 Gemini 生成 3 區塊，存 KV
async function buildUsAnalysis(top50, date) {
  if (!GEMINI_API_KEY) { console.log("美股AI：GEMINI_API_KEY 未設定，跳過"); return; }
  try {
    // ── 新進榜：跟昨天榜單比，找今天首次進前50的 ──
    const prevSnap = await kvGet("us_top50_prev");
    const prevCodes = new Set((prevSnap?.codes) || []);
    const todayCodes = top50.map(s => s.code);
    const newcomers = prevCodes.size
      ? top50.filter(s => !prevCodes.has(s.code))
      : [];   // 第一天沒有昨天資料，新進榜留空
    // 存今天榜單給明天比對
    await kvPut("us_top50_prev", { date, codes: todayCodes }, 86400 * 5);

    // ── 抓新聞：成交值全 50 檔 + 新進榜，去重（cron 背景慢慢掃，約11分鐘）──
    const allCodes = top50.map(s => s.code);
    const newsTargets = [...new Set([...allCodes, ...newcomers.map(s=>s.code)])];
    const newsMap = {};
    for (const code of newsTargets) {
      const titles = await fetchTickerNews(code, 3);
      if (titles.length) newsMap[code] = titles;
      await new Promise(res => setTimeout(res, 13000));   // 間隔13秒，守住免費5次/分上限
    }

    // ── 準備餵 Gemini 的素材 ──
    const top15txt = top50.slice(0, 15).map(s =>
      `${s.rank}. ${s.code}(${s.name}) 收$${s.price} 漲跌${s.chg>0?'+':''}${s.chg}% 成交額$${(s.dollarVol/1e9).toFixed(1)}B`
    ).join('\n');
    const newsTxt = Object.entries(newsMap).map(([c, ts]) => `${c}: ${ts.join(' / ')}`).join('\n') || '（無新聞資料）';
    const newcomerTxt = newcomers.length
      ? newcomers.map(s => `${s.code}(${s.name}) 漲跌${s.chg>0?'+':''}${s.chg}%`).join('、')
      : '（今日無新進榜，或首次執行尚無對照基準）';

    // ── 3 個 prompt（繁中、台股投資人口吻、簡潔）──
    const focusPrompt = `你是美股市場分析師，用繁體中文、台灣投資人習慣的口吻，根據以下「美股${date}成交值前15名」資料與相關新聞，寫一段約150字的「今日市場焦點」總結。點出今日資金集中在哪些族群、整體氣氛偏多或偏空、有無特別異動。只輸出總結本文，不要標題、不要條列、不要免責聲明。

成交值前15：
${top15txt}

相關新聞：
${newsTxt}`;

    const newcomerPrompt = `你是美股分析師，用繁體中文、台灣投資人口吻。以下是今日「首次進入成交值前50名」的個股，請針對每一檔用1-2句話解讀「為何今天爆量上榜」（結合提供的新聞；若無新聞則從漲跌幅與所屬產業合理推測，並註明為推測）。每檔格式：「**代碼 公司**：說明」。只輸出解讀，不要前言、不要免責。

新進榜個股：${newcomerTxt}

相關新聞：
${newsTxt}`;

    const themePrompt = `你是美股分析師，用繁體中文、台灣投資人口吻。根據以下美股${date}成交值前15名，把它們歸納成2-4個「今日發動題材／族群」（例如：AI半導體、記憶體、電動車、太空、金融等），依熱度排序。每個題材格式：「**題材名**：成員股代碼列表 — 一句話說明今日表現」。只輸出題材分析，不要前言、不要免責。

成交值前15：
${top15txt}`;

    // ── 呼叫 Gemini（序列+間隔，避免並發撞 10 RPM）──
    const focus = await callGemini(focusPrompt);
    await new Promise(res => setTimeout(res, 4000));
    const newcomer = newcomers.length ? await callGemini(newcomerPrompt) : '今日無新進榜個股。';
    await new Promise(res => setTimeout(res, 4000));
    const theme = await callGemini(themePrompt);

    const analysis = {
      ok: true, date, updatedAt: Date.now(),
      focus:    focus    || '（市場焦點生成失敗，稍後重試）',
      newcomer: newcomer || '（新進榜解讀生成失敗，稍後重試）',
      theme:    theme    || '（發動題材生成失敗，稍後重試）',
      newcomerCodes: newcomers.map(s => s.code),
    };
    await kvPut("us_analysis", analysis, 86400 * 3);
    console.log(`美股AI分析：focus=${!!focus} newcomer=${newcomers.length}檔 theme=${!!theme}`);
  } catch (e) {
    console.error("buildUsAnalysis error:", e.message);
  }
}

// AI 分析 endpoint：前端讀 KV
app.get("/api/us-analysis", async (req, res) => {
  try {
    const cached = await kvGet("us_analysis");
    if (cached && cached.ok) return res.json(cached);
    res.json({ ok: false, focus: '', newcomer: '', theme: '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 手動觸發：重抓行情+背景生成AI分析（測試用，不用等13:30 cron）
// 非阻塞——立即回應，AI分析在背景慢慢跑（抓50檔新聞約11分鐘），完成後存KV
app.get("/api/us-rebuild", async (req, res) => {
  try {
    const r = await buildUsTop50();   // 行情快，先同步跑完
    if (!r.ok) return res.status(502).json(r);
    // AI分析背景跑，不等它（避免HTTP timeout）
    buildUsAnalysis(r.data, r.date).catch(e => console.error("background analysis:", e.message));
    res.json({
      ok: true, date: r.date, count: r.count,
      note: "行情已更新。AI分析在背景生成中（抓全50檔新聞約11分鐘），完成後可讀 /api/us-analysis 查看。",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await updateSectorNews();
  await updateTwNews();   // 啟動先抓一次台股新聞，不用等第一個5分鐘
});
