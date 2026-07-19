import express from "express";
import cron from "node-cron";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

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
const FINMIND_TOKEN = process.env.FINMIND_TOKEN || "";   // 籌碼三指標用；沒填也能跑（300次/hr）

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
// Google News RSS：加瀏覽器 UA（防共享IP被當機器人）＋10分鐘記憶體快取（降請求量防限流）＋空結果印 status（診斷用）
const _rssCache = new Map();   // keyword -> { at, text }
async function fetchGoogleRSS(keyword) {
  const hit = _rssCache.get(keyword);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "application/rss+xml,application/xml,text/xml,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
    });
    const text = await res.text();
    if (!res.ok || !text.includes("<item>")) {
      console.log(`⚠️ Google RSS「${keyword}」空/擋：status=${res.status} len=${text.length}（共享IP限流約4hr自復）`);
    }
    if (text.includes("<item>")) _rssCache.set(keyword, { at: Date.now(), text });   // 只快取有料的
    if (_rssCache.size > 200) _rssCache.clear();   // 防記憶體膨脹，粗暴清空即可
    return text;
  } catch (err) {
    console.log("RSS error:", err.message);
    return "";
  }
}

function parseRSS(rss, limit = 20) {
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

  return items.slice(0, limit);
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
  // tpex 對雲端 IP 偶爾中途掐線（error: terminated），實測「再打一次就好」→ 自動重試 3 次、每次隔 20 秒
  let last = { ok: false, status: 0, head: "", data: [] };
  let json = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      if (Array.isArray(parsed) && parsed.length) { json = parsed; last.status = status; break; }
      last = { ok: false, status, head: text.slice(0, 200), data: [] };
    } catch (e) {
      last = { ok: false, status: 0, head: `第${attempt}次: ${e.message}`, data: [] };
    }
    if (attempt < 3) {
      console.log(`櫃買第 ${attempt} 次抓取失敗（${last.head || "status=" + last.status}），20 秒後重試…`);
      await new Promise(res => setTimeout(res, 20000));
    }
  }
  if (!json) return last;
  const status = last.status;
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
      o: num(row.Open), h: num(row.High), l: num(row.Low),
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
      o: num(row[4]), h: num(row[5]), l: num(row[6]),
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

// 萬用台股日期解析：吃 115/07/03、1150703、115年07月03日、2026-07-03、2026/07/03、20260703
// 解析成功回 YYYY-MM-DD，失敗回 null（榜日一律認資料，解析不到才推定）
function parseTwDate(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{3})[\/年.\-]?(\d{2})[\/月.\-]?(\d{2})/);        // 民國 3碼開頭
  if (m && +m[1] < 200) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[\/\-.]?(\d{2})[\/\-.]?(\d{2})/);               // 西元 4碼開頭
  if (m && +m[1] > 1990 && +m[1] < 2100) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// ── 定榜比對（台/美共用）：NEW、▲▼、在榜天數一律跟「昨天定榜」比 ──
// 規則：同一天不管重建幾次，基準都是昨天 → NEW 整天不被洗掉、▲▼ 穩定、天數=昨天+1
// 缺角回看：若昨天定榜櫃買數=0（tpex 抽風日），該檔查無時自動往前多翻（最多共4份）
// 距離「下一個台灣 hour:min」的秒數（跳過週六日；與 Worker 同款，供 KV 過期用）
function ttlUntilTw(hour, min) {
  const TW = 8 * 60 * 60 * 1000;
  const now = new Date(Date.now() + TW);                 // 以 UTC 取值代表台灣時間
  const target = new Date(now.getTime());
  target.setUTCHours(hour, min, 0, 0);
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1); // 已過 → 明天
  let dow = target.getUTCDay();
  while (dow === 0 || dow === 6) { target.setUTCDate(target.getUTCDate() + 1); dow = target.getUTCDay(); } // 跳過六日
  return Math.max(3600, Math.round((target.getTime() - now.getTime()) / 1000));      // 至少 1 小時
}

function shiftDateStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function applyBoardHistory(kvKey, date, top50, otcTester) {
  let store = null;
  try { store = await kvGet(kvKey); } catch {}
  // ── 首次遷移：從舊 tw_history / us_history 建基準，保留既有天數 ──
  if (!store || !Array.isArray(store.dates)) {
    store = { dates: [], boards: {} };
    const legacyKey = kvKey === "tw_board_history" ? "tw_history" : "us_history";
    let legacy = null;
    try { legacy = await kvGet(legacyKey); } catch {}
    if (legacy && typeof legacy === "object") {
      let base = "";
      for (const c in legacy) { const d = legacy[c] && legacy[c].lastDate; if (d && d > base) base = d; }
      if (base) {
        const sameDay = base === date;                          // 舊帳寫到今天 → 掛成「昨天」當基準
        const pseudoDate = sameDay ? shiftDateStr(base, -1) : base;
        const list = {};
        for (const c in legacy) {
          const h = legacy[c];
          if (!h || h.lastDate !== base) continue;
          const rank = sameDay ? (h.prevRank ?? h.lastRank) : h.lastRank;
          const days = Math.max(1, (h.days || 1) - (sameDay ? 1 : 0));
          if (rank) list[c] = { rank, days };
        }
        if (Object.keys(list).length) {
          store.dates = [pseudoDate];
          store.boards[pseudoDate] = { otcCount: -1, list };     // -1=未知（遷移資料），視為完整
          console.log(`${kvKey} 首次遷移：以 ${base} 舊帳建基準（${Object.keys(list).length} 檔，掛在 ${pseudoDate}）`);
        }
      }
    }
  }
  // ── 取昨天以前的定榜鏈（最近在前，最多翻 4 份）──
  const prevDates = store.dates.filter(d => d < date).sort().reverse().slice(0, 4);
  const chain = prevDates.map(d => store.boards[d]).filter(b => b && b.list);
  const findPrev = (code) => {
    for (const b of chain) {
      const hit = b.list[code];
      if (hit) return hit;
      if (b.otcCount !== 0) return null;   // 這份是完整榜還查無 → 真的不在榜；缺角榜(0)才往前翻
    }
    return null;
  };
  const out = top50.map(s => {
    const prev = findPrev(s.code);
    const days = prev ? (prev.days || 1) + 1 : 1;
    const isNew = chain.length > 0 && !prev;
    const rankChange = prev && prev.rank ? (prev.rank - s.rank) : 0;
    return { ...s, days, isNew, rankChange };
  });
  // ── 寫回今天定榜（同日重建覆蓋沒差，因為基準固定是昨天）──
  const list = {};
  let otcN = 0;
  for (const s of out) {
    list[s.code] = { rank: s.rank, days: s.days };
    if (otcTester && otcTester(s)) otcN++;
  }
  if (!store.dates.includes(date)) store.dates.push(date);
  store.boards[date] = { otcCount: otcTester ? otcN : -1, list };
  store.dates.sort();
  while (store.dates.length > 6) { const drop = store.dates.shift(); delete store.boards[drop]; }
  await kvPut(kvKey, store, 86400 * 30);
  return out;
}

// ── FinMind 極簡客戶端（僅籌碼指標用；上限 600次/hr，本站一天 3~4 發）──
async function finmindGet(dataset, params = {}) {
  const qs = new URLSearchParams({ dataset, ...params });
  const url = `https://api.finmindtrade.com/api/v4/data?${qs.toString()}`;
  const headers = { "User-Agent": BROWSER_UA, "Accept": "application/json" };
  if (FINMIND_TOKEN) headers["Authorization"] = `Bearer ${FINMIND_TOKEN}`;
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!json || json.status !== 200 || !Array.isArray(json.data)) {
      return { ok: false, status: r.status, msg: json && json.msg, head: text.slice(0, 150), data: [] };
    }
    return { ok: true, status: r.status, data: json.data };
  } catch (e) { return { ok: false, status: 0, msg: e.message, data: [] }; }
}

// ── 融資維持率（2026-07-15 新增）─────────────────────────────────────────
// 大盤融資維持率 = Σ(每檔融資餘額張數 × 1000 × 收盤價) ÷ 融資金額 × 100%
//   融資買進當下 = 166%（融資六成）；跌到 130% 券商發追繳令 → 逼近 130% 代表散戶接近全面斷頭。
// 資料全走證交所（免費、無額度、不吃 FinMind；跟 STOCK_DAY_ALL 同網域同吃法）：
//   MI_MARGN?selectType=ALL  → ①個股融資今日餘額(張) ②信用交易統計的融資金額(仟元)＋融資交易單位總計
//   MI_INDEX?type=ALLBUT0999 → 該日全市場個股收盤價（date 可回溯，60 天歷史靠這支補）
// ⚠️ 只含上市（證交所沒有上櫃資料；上櫃要另打 tpex，口徑不同）→ 前端標「上市」。
// ⚠️ 護欄：個股張數加總必須等於統計總額（誤差 <0.5%），對不上就回 null。
//     寧可沒有，不要給假數字——欄位位置抓錯/逗號沒剝乾淨，加總立刻會不合。
// ────────────────────────────────────────────────────────────────────

// TWSE 回應有新舊兩種格式：新的是 {tables:[{title,fields,data}]}、舊的是 {fields,data,fields1,data1,...}
function twseTables(json) {
  if (!json) return [];
  if (Array.isArray(json.tables)) return json.tables;
  const out = [];
  for (const sfx of ["", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    const f = json[`fields${sfx}`], d = json[`data${sfx}`];
    if (Array.isArray(f) && Array.isArray(d) && d.length) out.push({ title: json[`title${sfx}`] || "", fields: f, data: d });
  }
  return out;
}
// 依「欄位名必須全部出現」找表（比認 index 穩，TWSE 偶爾插欄）
function twsePickTable(tables, ...needles) {
  return tables.find(t => needles.every(n => (t.fields || []).some(f => String(f).includes(n))));
}
const twseNum = v => {
  const n = parseFloat(String(v == null ? "" : v).replace(/[",=\s]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const twseCode = v => String(v == null ? "" : v).replace(/[="\s]/g, "");

// MI_MARGN → { units:{code:張}, totalUnits, amountK }（amountK 單位＝仟元）
async function fetchMarginDetail(ymd) {
  const url = `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${ymd}&selectType=ALL`;
  const res = await fetchHtml(url);
  let json; try { json = JSON.parse(res); } catch { console.log(`⚠️ 維持率 MI_MARGN ${ymd}：非 JSON，len=${(res || "").length}`); return null; }
  if (json.stat && json.stat !== "OK") { console.log(`⚠️ 維持率 MI_MARGN ${ymd}：stat=${json.stat}`); return null; }
  const tables = twseTables(json);

  // ① 信用交易統計：抓「融資金額(仟元)」與「融資(交易單位)」兩列的今日餘額
  const stat = twsePickTable(tables, "項目", "今日餘額") || twsePickTable(tables, "今日餘額");
  let amountK = null, totalUnits = null;
  if (stat) {
    const iToday = stat.fields.findIndex(f => String(f).includes("今日餘額"));
    for (const row of stat.data) {
      const item = String(row[0] || "");
      if (item.includes("融資金額")) amountK = twseNum(row[iToday]);
      else if (item.includes("融資") && item.includes("交易單位")) totalUnits = twseNum(row[iToday]);
    }
  }

  // ② 個股明細：代號 + 融資今日餘額（張）。融資/融券欄位同名，故用位置：0代號 1名稱 2~7融資 8~13融券
  const det = tables.find(t => (t.data || []).length > 500 && (t.fields || []).length >= 14);
  if (!det || amountK == null || totalUnits == null) {
    console.log(`⚠️ 維持率 MI_MARGN ${ymd}：表結構不符（tables=${tables.length} 明細=${det ? det.data.length : 0} 金額=${amountK} 單位=${totalUnits}）`);
    return null;
  }
  // ⚠️ 代號不是只有純數字：槓桿/反向ETF(00631L、00632R)、特別股(2887B)、外幣ETF(第六碼K/M/S/C)都帶字母。
  //    2026-07-15 首次上線就是被 /^\d{4,6}$/ 濾掉這些，對帳短少 23.46%。改成「數字開頭」即可。
  const units = {};
  let sum = 0, skipN = 0, skipU = 0;
  for (const row of det.data) {
    const code = twseCode(row[0]);
    const u = twseNum(row[6]);           // 融資今日餘額（張）
    if (!/^\d/.test(code) || code.length < 4) { if (u) { skipN++; skipU += u; } continue; }
    if (u == null) continue;
    units[code] = u; sum += u;
  }
  if (skipU) console.log(`維持率 ${ymd}：代號不合格式跳過 ${skipN} 檔／${skipU} 張`);
  // 對帳點：個股加總 vs 統計總額。對不上＝欄位抓錯，直接放棄（不給假數字）
  const diff = totalUnits ? Math.abs(sum - totalUnits) / totalUnits : 1;
  if (diff > 0.005) {
    // 遺言：印出前 5 大融資檔＋跳過量，下次不用瞎猜是哪裡漏
    const top = Object.entries(units).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, u]) => `${c}:${u}`).join(" ");
    console.log(`⚠️ 維持率 ${ymd} 對帳失敗：個股加總=${sum}（${Object.keys(units).length}檔）vs 統計總額=${totalUnits}` +
      `（差 ${(diff * 100).toFixed(2)}%／${totalUnits - sum} 張）→ 放棄｜跳過 ${skipN}檔/${skipU}張｜前5大 ${top}`);
    return null;
  }
  return { units, totalUnits, amountK };
}

// MI_INDEX → { code: 收盤價 }
async function fetchCloseMap(ymd) {
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${ymd}&type=ALLBUT0999`;
  const res = await fetchHtml(url);
  let json; try { json = JSON.parse(res); } catch { console.log(`⚠️ 維持率 MI_INDEX ${ymd}：非 JSON，len=${(res || "").length}`); return null; }
  if (json.stat && json.stat !== "OK") { console.log(`⚠️ 維持率 MI_INDEX ${ymd}：stat=${json.stat}`); return null; }
  const t = twsePickTable(twseTables(json), "證券代號", "收盤價");
  if (!t) { console.log(`⚠️ 維持率 MI_INDEX ${ymd}：找不到個股表`); return null; }
  const iCode = t.fields.findIndex(f => String(f).includes("證券代號"));
  const iClose = t.fields.findIndex(f => String(f).includes("收盤價"));
  const map = {};
  for (const row of t.data) {
    const c = twseCode(row[iCode]), p = twseNum(row[iClose]);
    if (/^\d/.test(c) && c.length >= 4 && p != null && p > 0) map[c] = p;
  }
  return Object.keys(map).length > 500 ? map : null;
}

// 單日維持率：ymd = YYYYMMDD → { d:"MM/DD", v:百分比 } 或 null
async function calcMarginRatio(ymd) {
  const [det, close] = await Promise.all([fetchMarginDetail(ymd), fetchCloseMap(ymd)]);
  if (!det || !close) return null;
  let mv = 0, hit = 0, miss = 0;
  for (const code in det.units) {
    const u = det.units[code], p = close[code];
    if (!u) continue;                      // 無融資餘額的檔跳過
    if (p == null) { miss += u; continue; } // 有融資但查無收盤價（暫停交易等）
    mv += u * 1000 * p; hit++;
  }
  const denom = det.amountK * 1000;        // 仟元 → 元
  if (!denom || !hit) return null;
  const ratio = mv / denom * 100;
  if (!(ratio > 80 && ratio < 400)) {      // 合理區間護欄：正常落在 130~180
    console.log(`⚠️ 維持率 ${ymd} 算出 ${ratio.toFixed(1)}% 不合理 → 放棄（市值=${mv} 融資額=${denom}）`);
    return null;
  }
  if (miss) console.log(`維持率 ${ymd}：${miss} 張查無收盤價（已排除）`);
  return { d: `${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`, v: +ratio.toFixed(1) };
}

// margin_ratio 滾動庫：{asOf, count, series:[{d,v}]}
// 首次（KV 空）自動回溯 60 個交易日＝120 發 TWSE；之後每天只補缺的那幾天（1 天＝2 發）。
// 節奏比照 buildHigh5y：一天一天來、間隔 250ms，別把證交所打爆。
async function buildMarginRatio(maxDays = 60) {
  const old = (await kvGet("margin_ratio")) || null;
  const have = new Set((old && old.series || []).map(x => x.d));
  // 產生近 maxDays 個交易日（跳週末；國定假日靠 TWSE 回 stat!=OK 自然略過）
  const wants = [];
  for (let i = 0; wants.length < maxDays && i < maxDays * 2 + 20; i++) {
    const iso = shiftDateStr(twTradingDate(0), -i);
    const dow = new Date(iso + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    wants.push(iso.replace(/-/g, ""));
  }
  wants.reverse();
  const todo = wants.filter(ymd => !have.has(`${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`));
  if (!todo.length) { console.log(`維持率：已是最新（${have.size} 天），不需補`); return old; }
  console.log(`維持率：需補 ${todo.length} 天（庫存 ${have.size} 天）→ 約 ${todo.length * 2} 發 TWSE`);

  const got = [];
  for (const ymd of todo) {
    try {
      const r = await calcMarginRatio(ymd);
      if (r) got.push(r);
    } catch (e) { console.log(`維持率 ${ymd} error: ${e.message}`); }
    await new Promise(r => setTimeout(r, 250));
  }
  const merged = new Map((old && old.series || []).map(x => [x.d, x.v]));
  for (const g of got) merged.set(g.d, g.v);
  // 依 MM/DD 排序時跨年會亂 → 用 wants 的順序當權威排序
  const order = new Map(wants.map((ymd, i) => [`${ymd.slice(4, 6)}/${ymd.slice(6, 8)}`, i]));
  const series = [...merged.entries()]
    .filter(([d]) => order.has(d))
    .sort((a, b) => order.get(a[0]) - order.get(b[0]))
    .slice(-maxDays)
    .map(([d, v]) => ({ d, v }));
  const pack = { asOf: twTradingDate(0), count: series.length, series };
  await kvPut("margin_ratio", pack, 86400 * 30);
  console.log(`維持率：新增 ${got.length} 天 → 庫存 ${series.length} 天` +
    (series.length ? `，最新 ${series[series.length - 1].d}=${series[series.length - 1].v}%` : ""));
  return pack;
}

// ── 籌碼三指標（風度頁）：外資台指淨OI / 散戶微台淨OI / 融資餘額 ──
// 每交易日約 22:10 由 cron 產生（融資約 21:00 後才公布）；🔄 一鍵重建也會順手更新。
// 散戶淨OI 數學恆等式：全市場多單=空單 → 散戶淨 = −(三大法人淨合計)，不需另抓總OI。
// ── 台指 VIX（TAIFEX 官方每日收盤波動率指數；風度頁取代融資維持率卡）──
// 檔案：https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/{YYYYMM}new.txt（每月一檔）
// 格式：tab 分隔、前 2 行標題(欄名+分隔線)、欄=[交易日期YYYYMMDD, 時間, 收盤VIX, 收盤前1分均值]
// 取當月＋前 2 月拼 45 交易日；免費、官方、穩定（跟抓 TWSE/tpex 同套路，加瀏覽器 UA）
async function fetchTaifexVix(end) {
  const map = {};   // "YYYYMMDD" -> 收盤VIX
  // end 是 "YYYY-MM-DD"（twTradingDate 回傳帶橫線）→ 用 split 拆，別用 slice
  const parts = String(end).split("-");
  const yr = +parts[0], mo = +parts[1];
  const months = [];
  for (let i = 0; i < 4; i++) {   // 當月 + 前 3 月（60 交易日約 2.9 個月，月初邊界需 4 個月才夠）
    let m = mo - i, y = yr;
    while (m <= 0) { m += 12; y -= 1; }
    months.push(`${y}${String(m).padStart(2, "0")}`);
  }
  for (const ym of months) {
    try {
      const url = `https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/${ym}new.txt`;
      // 加更完整的瀏覽器 headers 騙過雲主機軟擋（Referer/Accept/Accept-Language）
      const r = await fetch(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept": "text/plain,text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
          "Referer": "https://www.taifex.com.tw/cht/7/vixDaily3MNew",
        },
      });
      const txt = await r.text();
      // 診斷 log：印狀態＋body開頭，判斷收到真資料還是反爬頁（HTML）
      const before = Object.keys(map).length;
      for (const line of txt.split(/\r?\n/)) {
        // 檔案欄位用「多個 tab」對齊，故用 /\s+/ 切並濾空欄：[0]日期 [1]時間 [2]收盤VIX [3]收盤前1分均值
        const cols = line.trim().split(/\s+/).filter(Boolean);
        if (cols.length < 3) continue;
        const d = cols[0];
        if (!/^\d{8}$/.test(d)) continue;   // 跳標題/分隔線，只收 YYYYMMDD 資料列
        const v = parseFloat(cols[2]);       // 第 3 欄＝當日收盤 VIX
        if (isFinite(v) && v > 0) map[d] = v;
      }
      const got = Object.keys(map).length - before;
      console.log(`台指VIX ${ym}: status=${r.status} ok=${r.ok} len=${txt.length} 解析${got}筆 head=${JSON.stringify(txt.slice(0, 60))}`);
    } catch (e) { console.log(`⚠️ 台指VIX ${ym} error: ${e.message}`); }
  }
  return map;
}

async function buildChipIndicators() {
  try {
    const end = twTradingDate(0);
    const start = shiftDateStr(end, -100);   // 100 日曆天 ≈ 65+ 交易日，取尾 60
    const startK = shiftDateStr(end, -185);  // K線要 60 根＋前置 59 根算 60MA
    const [fut, mtx0, tmf0, mar, kraw, kraw2] = await Promise.all([
      finmindGet("TaiwanFuturesInstitutionalInvestors", { data_id: "TX",  start_date: start, end_date: end }),
      finmindGet("TaiwanFuturesInstitutionalInvestors", { data_id: "MTX", start_date: start, end_date: end }),
      finmindGet("TaiwanFuturesInstitutionalInvestors", { data_id: "TMF", start_date: start, end_date: end }),
      finmindGet("TaiwanStockTotalMarginPurchaseShortSale", { start_date: start, end_date: end }),
      finmindGet("TaiwanStockPrice", { data_id: "TAIEX", start_date: startK, end_date: end }),
      finmindGet("TaiwanStockPrice", { data_id: "TPEx", start_date: startK, end_date: end }),
    ]);
    // 櫃買指數代號防禦：TPEx 沒資料就退 TPEX 再試一次
    let otcIdx = kraw2;
    if (!otcIdx.ok || otcIdx.data.length < 30) {
      const alt = await finmindGet("TaiwanStockPrice", { data_id: "TPEX", start_date: startK, end_date: end });
      if (alt.ok && alt.data.length >= 30) { otcIdx = alt; console.log("指數K：櫃買改用代號 TPEX"); }
    }
    // 2026-07-15：小台(MTX)＝主圖、微台(TMF)＝副圖，兩個都常駐。
    // 舊的「微台沒資料自動退小台」備胎已移除（使用者拍板）：哪個沒資料哪個就空著，不互相頂替。
    // 台指 VIX（TAIFEX 官方，取代融資維持率卡）
    const vixMap = await fetchTaifexVix(end);
    const bad = [];
    if (!fut.ok) bad.push(`台指法人(status=${fut.status} msg=${(fut.msg||"-").slice(0,80)})`);
    if (!mtx0.ok) bad.push(`小台法人(status=${mtx0.status} msg=${(mtx0.msg||"-").slice(0,80)})`);
    if (!tmf0.ok) bad.push(`微台法人(status=${tmf0.status} msg=${(tmf0.msg||"-").slice(0,80)})`);
    if (!mar.ok) bad.push(`整體融資(status=${mar.status} msg=${(mar.msg||"-").slice(0,80)})`);
    if (!kraw.ok) bad.push(`加權指數K線(status=${kraw.status} msg=${(kraw.msg||"-").slice(0,80)})`);
    if (!otcIdx.ok) bad.push(`櫃買指數K線(status=${otcIdx.status} msg=${(otcIdx.msg||"-").slice(0,80)})`);
    if (bad.length) console.log(`⚠️ 籌碼指標來源失敗：${bad.join("；")}`);

    const dlabel = (d) => d.slice(5).replace("-", "/");
    // ① 外資台指淨OI（餘額）
    const fmap = {};
    for (const r of fut.data) {
      if (!String(r.institutional_investors || "").includes("外資")) continue;
      fmap[r.date] = (+r.long_open_interest_balance_volume || 0) - (+r.short_open_interest_balance_volume || 0);
    }
    // ② 散戶淨OI = −(法人淨合計)。小台(MTX)與微台(TMF) 各算一份，互不頂替。
    const netMap = (src) => {
      const m = {};
      if (!src || !src.ok) return m;
      for (const r of src.data) {
        const net = (+r.long_open_interest_balance_volume || 0) - (+r.short_open_interest_balance_volume || 0);
        m[r.date] = (m[r.date] || 0) + net;
      }
      for (const d in m) m[d] = -m[d];
      return m;
    };
    const rmap = netMap(mtx0);      // 小台＝主圖
    const rmap2 = netMap(tmf0);     // 微台＝副圖
    // ③ 整體融資（元 → 億）：name 匹配失敗時把清單留在 log 當遺言
    const mmap = {}; const names = new Set();
    for (const r of mar.data) {
      const nm = String(r.name || ""); names.add(nm);
      if (!(nm.includes("MarginPurchaseMoney") || nm.includes("融資金額"))) continue;
      // 實測 log：TodayBalance 單位是「元」（07-06 印出 6308124.8億=除錯），元→億 除 1e8
      const bal = (+r.TodayBalance || 0) / 1e8;
      mmap[r.date] = { bal, chg: ((+r.TodayBalance || 0) - (+r.YesBalance || 0)) / 1e8 };
    }
    if (!Object.keys(mmap).length && mar.data.length) console.log(`⚠️ 融資表 name 無匹配，清單：${[...names].join(",").slice(0, 200)}`);


    // ⑤ 指數雙K（加權＋櫃買）：60 根 K 棒＋20MA＋均線彎向＋逐日風度
    //    風度真值表（與 Worker computeWindGauge 完全一致）：
    //    站上20MA×MACD柱(12/26/9)今>昨=強風；站上×柱走弱=亂流；線下×柱轉強=陣風；線下×柱走弱=無風
    const emaSeries = (vals, n) => {
      const k = 2 / (n + 1); let e = null;
      return vals.map(v => (e = e == null ? v : v * k + e * (1 - k)));
    };
    const buildIdx = (raw, name) => {
      if (!raw.ok || raw.data.length < 40) {
        if (raw.ok) console.log(`⚠️ ${name}指數K資料過少（${raw.data.length} 筆），跳過`);
        return null;
      }
      const rows = raw.data.filter(r => +r.close > 0)
        .sort((x, y) => String(x.date).localeCompare(String(y.date)));
      const closes = rows.map(r => +r.close);
      const ma20 = closes.map((_, i) => {
        if (i < 19) return null;
        let s = 0;
        for (let j = i - 19; j <= i; j++) s += closes[j];
        return +(s / 20).toFixed(2);
      });
      const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
      const macd = closes.map((_, i) => e12[i] - e26[i]);
      const sig = emaSeries(macd, 9);
      const hist = macd.map((v, i) => v - sig[i]);
      const full = rows.map((r, i) => {
        const c = +r.close, m = ma20[i];
        const aboveMA = m != null && c >= m;
        const histUp = i > 0 && hist[i] > hist[i - 1];
        const w = m == null ? null : (aboveMA ? (histUp ? "強風" : "亂流") : (histUp ? "陣風" : "無風"));
        return {
          d: dlabel(r.date),
          o: +(+r.open).toFixed(2), h: +(+r.max).toFixed(2), l: +(+r.min).toFixed(2), c: +c.toFixed(2),
          chg: i > 0 ? +(c - closes[i - 1]).toFixed(2) : 0,
          pct: i > 0 && closes[i - 1] > 0 ? +((c - closes[i - 1]) / closes[i - 1] * 100).toFixed(2) : 0,
          m,
          s: (m != null && ma20[i - 1] != null) ? (m >= ma20[i - 1] ? 1 : -1) : 0,
          w,
          dif: +macd[i].toFixed(2), hist: +hist[i].toFixed(2),   // MACD副圖（12,26,9）：DIF與柱，訊號線=dif-hist 前端自推
        };
      });
      const series = full.slice(-60);   // 存 60 交易日（前端依裝置切：手機30/桌機60）
      if (series.length < 20) return null;
      // 盤中即時風度「MACD存檔點」：最後一根的 ema12/ema26/sig9 原始值
      // （MACD遞迴，前端/Worker 拿存檔點＋即時價四行乘法即可延伸今日暫定柱，免回傳185根重算）
      const li = closes.length - 1;
      return { series, ema12: +e12[li].toFixed(4), ema26: +e26[li].toFixed(4), sig9: +sig[li].toFixed(4) };
    };
    const idx = { tse: buildIdx(kraw, "加權"), otc: buildIdx(otcIdx, "櫃買") };

    const tailN = (map, n) => Object.keys(map).sort().slice(-n);
    const fD = tailN(fmap, 60), rD = tailN(rmap, 60), rD2 = tailN(rmap2, 60), mD = tailN(mmap, 60);
    // 融資維持率（TWSE 自算、零 FinMind）：讀滾動庫並順手補今天
    let ratio = null;
    try { ratio = await buildMarginRatio(60); } catch (e) { console.log("維持率 build error:", e.message); }
    const mkSeries = (dates, map, round) => dates.map(d => ({ d: dlabel(d), v: round(map[d]) }));
    const pack = {
      ok: !!(fD.length || rD.length || rD2.length || mD.length || idx.tse || idx.otc),
      updatedAt: Date.now(),
      idx,
      foreign: fD.length ? {
        series: mkSeries(fD, fmap, v => Math.round(v)),
        latest: Math.round(fmap[fD[fD.length - 1]]),
        chg: fD.length > 1 ? Math.round(fmap[fD[fD.length - 1]] - fmap[fD[fD.length - 2]]) : 0,
      } : null,
      // 小台(MTX)＝主圖、微台(TMF)＝副圖。哪個沒資料哪個為 null（不互相頂替）
      retail: rD.length ? {
        label: "小台",
        series: mkSeries(rD, rmap, v => Math.round(v)),
        latest: Math.round(rmap[rD[rD.length - 1]]),
        chg: rD.length > 1 ? Math.round(rmap[rD[rD.length - 1]] - rmap[rD[rD.length - 2]]) : 0,
      } : null,
      retail2: rD2.length ? {
        label: "微台",
        series: mkSeries(rD2, rmap2, v => Math.round(v)),
        latest: Math.round(rmap2[rD2[rD2.length - 1]]),
        chg: rD2.length > 1 ? Math.round(rmap2[rD2[rD2.length - 1]] - rmap2[rD2[rD2.length - 2]]) : 0,
      } : null,
      margin: mD.length ? {
        series: mkSeries(mD, mmap, o => +o.chg.toFixed(1)),
        balSeries: mkSeries(mD, mmap, o => +o.bal.toFixed(1)),
        bal: +mmap[mD[mD.length - 1]].bal.toFixed(1),
        chg: +mmap[mD[mD.length - 1]].chg.toFixed(1),
        // 融資維持率副圖（證交所自算、僅上市）：166%=融資買進當下、130%=券商追繳線
        ratioSeries: (ratio && ratio.series && ratio.series.length) ? ratio.series : null,
        ratio: (ratio && ratio.series && ratio.series.length) ? ratio.series[ratio.series.length - 1].v : null,
        ratioChg: (ratio && ratio.series && ratio.series.length > 1)
          ? +(ratio.series[ratio.series.length - 1].v - ratio.series[ratio.series.length - 2].v).toFixed(1) : null,
      } : null,
      vix: (() => {
        const vd = Object.keys(vixMap).sort().slice(-60);
        if (!vd.length) return null;
        const lbl = d => d.slice(4, 6) + "/" + d.slice(6, 8);   // YYYYMMDD → MM/DD
        return {
          series: vd.map(d => ({ d: lbl(d), v: +vixMap[d].toFixed(2) })),
          latest: +vixMap[vd[vd.length - 1]].toFixed(2),
          chg: vd.length > 1 ? +(vixMap[vd[vd.length - 1]] - vixMap[vd[vd.length - 2]]).toFixed(2) : 0,
        };
      })(),
    };
    if (pack.ok) {
      await kvPut("chip_indicators", pack, 86400 * 7);
      console.log(`籌碼指標更新：外資${fD.length}天 / 小台${rD.length}天 / 微台${rD2.length}天 / 融資${mD.length}天 / 加權K${idx.tse ? idx.tse.series.length : 0} / 櫃買K${idx.otc ? idx.otc.series.length : 0}` +
        (pack.margin ? `｜融資餘額=${pack.margin.bal}億（變動${pack.margin.chg >= 0 ? "+" : ""}${pack.margin.chg}億）` : "") +
        (pack.vix ? `｜台指VIX=${pack.vix.latest}（${pack.vix.series.length}天）` : "｜台指VIX:無") +
        (pack.margin && pack.margin.ratio != null ? `｜融資維持率=${pack.margin.ratio}%（${pack.margin.ratioSeries.length}天）` : "｜融資維持率:無"));
    } else {
      console.log("⚠️ 籌碼三指標全空，未寫入 KV");
    }
    return pack;
  } catch (e) {
    console.error("buildChipIndicators error:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── 月K創新高基準（盤中「月K」欄 + Top50「創新高」欄用）：120 池逐檔查 FinMind 5 年日K，
//    排除最近 22 交易日後取最高 max＋高點日期 → {v,d}。突破＝「至少一個月沒看過的高價」──
// 每天台北 0:00 由 cron 產生（獨佔 FinMind 時段）。🔄 一鍵重建「不」觸發；驗證用 /api/tw-high5y 手動打。
async function buildHigh5y() {
  try {
    const pool = await kvGet("pending_stocklist");
    if (!Array.isArray(pool) || !pool.length) {
      console.log("⚠️ 創新高 high5y：無 pending_stocklist，跳過");
      return { ok: false, error: "no pending_stocklist" };
    }
    const asOf = twTradingDate(1);              // 昨天（最後完成的交易日；不含今天）
    const start = shiftDateStr(asOf, -1830);    // ~5 年
    const codes = [...new Set(pool.map(s => String(s.code)).filter(Boolean))];
    const map = {};
    const failed = [];
    // ── RS 相對動能（20交易日、全體 vs 加權）：吃現成 chip_indicators 的加權日K，零額外 API ──
    const rsMap = {};
    let idxCloseByDate = null;
    try {
      const chip = await kvGet("chip_indicators");
      const tseSeries = chip && chip.idx && chip.idx.tse && Array.isArray(chip.idx.tse.series) ? chip.idx.tse.series : [];
      if (tseSeries.length >= 25) {
        idxCloseByDate = {};
        for (const b of tseSeries) { const c = +b.c; if (b.d && isFinite(c) && c > 0) idxCloseByDate[String(b.d)] = c; }
      } else console.log("⚠️ RS動能：chip_indicators 指數K不足，本輪跳過 RS");
    } catch (e) { console.log("⚠️ RS動能：讀 chip_indicators 失敗，本輪跳過（" + e.message + "）"); }
    // chip 的 d 是 dlabel 後的 "MM/DD"（07-13 確診：ISO 查 MM/DD 全空）；此函式兩種格式都吃
    const idxAt = (ds) => idxCloseByDate ? (idxCloseByDate[ds] ?? idxCloseByDate[String(ds).slice(5).replace("-", "/")]) : undefined;
    const CHUNK = 20;                           // 分批串行，錯開 FinMind 額度
    for (let i = 0; i < codes.length; i += CHUNK) {
      const batch = codes.slice(i, i + CHUNK);
      const rs = await Promise.all(batch.map(code =>
        finmindGet("TaiwanStockPrice", { data_id: code, start_date: start, end_date: asOf })
          .then(r => ({ code, r }))
      ));
      for (const { code, r } of rs) {
        if (!r.ok || !r.data.length) { failed.push(code); continue; }
        // 月K創新高定義：排除最近 22 交易日（台股月均），取「一個月前為止」的近五年最高＋高點日期
        const rows = r.data
          .filter(row => String(row.date) <= asOf && isFinite(+row.max) && +row.max > 0)
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        const usable = rows.slice(0, Math.max(0, rows.length - 22));   // 挖掉最近一個月
        let hi = 0, hiD = "";
        for (const row of usable) {
          const mx = +row.max;
          if (mx > hi) { hi = mx; hiD = row.date; }
        }
        if (hi > 0) map[code] = { v: +hi.toFixed(2), d: hiD };
        else failed.push(code);   // 資料不足22筆（新上市）或無有效價
        // RS 相對動能：近20交易日「個股倍率 ÷ 加權倍率 −1」(%)；
        // 護欄：不滿21根→不給值；相鄰兩根變動>±10.5%（台股漲跌停極限外）→視為除權息/減資缺口，不給值
        if (idxCloseByDate) {
          const closes = rows.map(x => ({ d: String(x.date), c: +x.close })).filter(x => isFinite(x.c) && x.c > 0);
          if (closes.length >= 21) {
            const seg = closes.slice(-21);
            let gap = false;
            for (let j = 1; j < seg.length; j++) { if (Math.abs(seg[j].c / seg[j - 1].c - 1) > 0.105) { gap = true; break; } }
            const i0 = idxAt(seg[20].d), i20 = idxAt(seg[0].d);
            if (!gap && i0 && i20) {
              const rsv = +((((seg[20].c / seg[0].c) / (i0 / i20)) - 1) * 100).toFixed(1);
              if (isFinite(rsv)) rsMap[code] = rsv;
            }
          }
        }
      }
      if (i + CHUNK < codes.length) await new Promise(r => setTimeout(r, 250));
    }
    const pack = { ok: Object.keys(map).length > 0, updatedAt: Date.now(), asOf, count: Object.keys(map).length, map };
    if (pack.ok) {
      await kvPut("high5y", pack, 86400 * 7);
      console.log(`創新高 high5y：${pack.count}/${codes.length} 檔，基準日 ${asOf}` +
        (failed.length ? `（缺 ${failed.length}：${failed.slice(0, 8).join(",")}${failed.length > 8 ? "…" : ""}）` : ""));
    } else {
      console.log("⚠️ 創新高 high5y 全空，未寫入 KV");
    }
    // ── rs20 寫入：map[code]={v:今日值, d:較昨日變化}；base=小數字基準（同日重跑凍結）──
    if (idxCloseByDate && Object.keys(rsMap).length) {
      const oldRs = await kvGet("rs20");
      let baseMap = {}, baseAsOf = null;
      if (oldRs && oldRs.asOf === asOf && oldRs.base && oldRs.base.map) {
        baseMap = oldRs.base.map; baseAsOf = oldRs.base.asOf;          // 同日重跑：基準凍結
      } else if (oldRs && oldRs.map) {
        baseAsOf = oldRs.asOf;                                          // 跨日：昨日值滾動成新基準
        for (const [k, x] of Object.entries(oldRs.map)) { const bv = (x && typeof x === "object") ? x.v : x; if (bv != null) baseMap[k] = bv; }
      }
      const rsOut = {};
      for (const [k, v] of Object.entries(rsMap)) {
        const b = baseMap[k];
        rsOut[k] = { v, d: (b == null ? null : +(v - b).toFixed(1)) };
      }
      const rsPack = { ok: true, updatedAt: Date.now(), asOf, count: Object.keys(rsOut).length, map: rsOut, base: { asOf: baseAsOf, map: baseMap } };
      await kvPut("rs20", rsPack, 86400 * 7);
      const vals = Object.values(rsMap).sort((a, b) => b - a);
      console.log(`RS動能 rs20：${rsPack.count}/${codes.length} 檔（max ${vals[0]}、min ${vals[vals.length - 1]}、中位 ${vals[Math.floor(vals.length / 2)]}）基準日 ${asOf}`);
    } else if (idxCloseByDate) {
      console.log("⚠️ RS動能：rsMap 全空（日期對不上或全被護欄擋），未寫入 rs20");
    }
    return pack;
  } catch (e) {
    console.error("buildHigh5y error:", e.message);
    return { ok: false, error: e.message };
  }
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
    if (!otcData.length) console.log(`⚠️ 櫃買抓不到（status=${otc.status ?? "-"} head=${(otc.head || "").slice(0, 120)}），本次為純上市資料；缺角回看會保護天數，可用說明頁按鈕手動重跑`);
    if (!tseData.length) console.log(`⚠️ 上市抓不到（status=${tse.status ?? "-"}），本次為純上櫃資料`);

    // 榜日一律認「資料自己的交易日」（民國/西元/無斜線格式都吃）；
    // 資料真的沒帶日期才推定：台灣 14:00 前＝今天還沒收盤 → 記前一交易日，之後才記今天。
    // 這樣不管幾點按手動重建，7/2 的資料永遠寫進 7/2 那格、跟 7/1 比，NEW/▲▼/天數不會被洗。
    const rawDate = tse.date || otc.date || "";
    let date = parseTwDate(rawDate);
    let dateSrc = date ? (tse.date ? "TSE" : "OTC") : "";
    if (!date) {
      const twNow = new Date(Date.now() + 8 * 3600 * 1000);
      date = twTradingDate(twNow.getUTCHours() < 14 ? 1 : 0);
      dateSrc = "推定";
    }
    console.log(`台股榜日=${date}（來源:${dateSrc}，raw="${String(rawDate).slice(0, 20)}"）`);

    // ── 合併、依成交值排序（掃描池不濾 ETF，與原 Worker 行為一致）──
    const merged = [...tseData, ...otcData].filter(s => s.tradeValue > 0);
    merged.sort((a, b) => b.tradeValue - a.tradeValue);

    // ── 盤後一條龍（原 Worker buildDailyData 職責搬來這裡，格式/TTL 完全一致）──
    // ① 股號→股名對照表（全台股，個股新聞查詢用）
    try {
      const codeNameMap = {};
      for (const s of merged) { if (s.code && s.name) codeNameMap[s.code] = { name: s.name, market: s.market }; }
      await kvPut("code_name_map", codeNameMap, 86400 * 3);
    } catch (e) { console.error("code_name_map error:", e.message); }
    // ② pending_stocklist：前120，隔天盤中警示池（08:30 由 Worker finalize 啟用）
    const pool = merged.slice(0, 120).map(s => ({
      code: s.code, name: s.name, market: s.market,
      prevLimit: s.chgPct >= 9.5,
      prevVol: s.vol || 0,
    }));
    await kvPut("pending_stocklist", pool, ttlUntilTw(9, 0));
    // ③ afterhours：前60名中漲幅≥7%（盤後追蹤頁）
    const surging = merged.slice(0, 60)
      .filter(s => s.chgPct >= 7)
      .sort((a, b) => b.chgPct - a.chgPct)
      .map(s => ({
        code: s.code, name: s.name, market: s.market,
        price: s.close, chg: s.chgPct, vol: s.vol, tradeValue: s.tradeValue,
        prevLimit: s.chgPct >= 9.5, prevVol: s.vol || 0,
      }));
    await kvPut("afterhours", surging, ttlUntilTw(14, 0));
    console.log(`盤後一條龍：對照表${merged.length}檔、掃描池${pool.length}檔、盤後追蹤${surging.length}檔`);

    // ── 近五日K滾動庫：同一份行情順手存全市場當日 OHLC（盤中「近五日K」欄用，零額外API）──
    try {
      const prev5 = await kvGet("ohlc_5d");
      const store = (prev5 && Array.isArray(prev5.dates) && prev5.map) ? prev5 : { dates: [], map: {} };
      if (!store.dates.includes(date)) store.dates.push(date);
      if (store.dates.length > 5) {
        const drop = store.dates.length - 5;
        store.dates = store.dates.slice(drop);
        for (const c in store.map) store.map[c] = (store.map[c] || []).slice(drop);
      }
      const L = store.dates.length, idx = store.dates.indexOf(date);
      for (const c in store.map) { const a = store.map[c]; while (a.length < L) a.push(null); }
      for (const s of merged) {
        if (!(s.o > 0 && s.close > 0)) continue;
        if (!store.map[s.code]) store.map[s.code] = new Array(L).fill(null);
        store.map[s.code][idx] = [s.o, s.h > 0 ? s.h : Math.max(s.o, s.close), s.l > 0 ? s.l : Math.min(s.o, s.close), s.close];
      }
      for (const c in store.map) { if (store.map[c].every(x => !x)) delete store.map[c]; }   // 清全空殘留
      await kvPut("ohlc_5d", store, 86400 * 10);
      console.log(`五日K滾動庫：${Object.keys(store.map).length} 檔 × ${L} 天（最新 ${date}）`);
    } catch (e) { console.error("ohlc_5d error:", e.message); }

    // ── Top50：排除 ETF（代碼開頭 00，如 0050/0056/00878）──
    const isTwEtf = (code) => /^00/.test(String(code));   // 台股 ETF 代碼開頭 00
    const all = merged.filter(s => s.close > 0 && !isTwEtf(s.code));
    let top50 = all.slice(0, 50).map((s, i) => ({
      rank: i + 1,
      code: s.code, name: s.name, market: s.market,
      price: s.close,
      chg: s.chgPct,
      tradeValue: s.tradeValue,
      vol: s.vol,
    }));

    // ── NEW / ▲▼ / 在榜天數：一律跟「昨天定榜」比（同日重跑不變；昨天缺角自動回看）──
    top50 = await applyBoardHistory("tw_board_history", date, top50, s => s.market === "OTC");

    // ── 創新高：用現成 high5y 凍結旗標（零額外查詢）。建榜17:00時 high5y=「到昨天」＝正確基準；
    //    凍進 tw_top50 → 事後幾點看都對，不隨 0:00 更新失真。──
    try {
      const h5pack = await kvGet("high5y");
      const h5 = (h5pack && h5pack.map) ? h5pack.map : {};
      let nhCount = 0;
      for (const s of top50) {
        const hv = h5[String(s.code)];
        const val = hv == null ? null : (typeof hv === "number" ? hv : hv.v);   // 兼容舊格式（純數字）
        s.newHigh = (val != null && s.price > val);
        if (s.newHigh) { nhCount++; if (hv && hv.d) s.nhD = hv.d; }             // 凍高點日期供前端顯示「破N年前高」
      }
      console.log(`Top50 創新高：${nhCount}/${top50.length} 檔（high5y 基準 ${h5pack ? h5pack.asOf : "無"}）`);
    } catch (e) { console.error("Top50 創新高 標記失敗:", e.message); }

    const otcCount = top50.filter(s => s.market === "OTC").length;
    const result = { ok: true, date, otcCount, count: top50.length, updatedAt: Date.now(), data: top50 };
    await kvPut("tw_top50", result, 86400 * 3);
    console.log(`台股Top50：date=${date} 共${top50.length}檔（TSE ${tseData.length}+OTC ${otcData.length}，榜內OTC ${otcCount}），新進榜${top50.filter(s => s.isNew).length}檔`);
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
    buildChipIndicators().catch(e => console.error("chip bg:", e.message));   // 籌碼三指標順手更新
    res.json({ ok: r.ok, date: r.date, count: r.count, otcCount: r.otcCount, note: r.ok ? `台股Top50已更新（榜內上櫃 ${r.otcCount} 檔），120檔掃描池與盤後追蹤已同步重建，AI題材分析背景生成中` : r.error });
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
  "summary": "一段像財經晨報的盤後總評(約120-140字，上限140、寧短勿長，通順一整段、不是條列)，照以下順序寫，共三段、寫完就停，每一段的字數也要照抓：(1)【約50字】開場先點今天台股被什麼外部力量帶動(如美股費半/那指隔夜表現；若無明顯外部驅動就直接講台股)，再接加權指數盤中走勢(開高走高/開低震盪)、收漲跌點數、成交金額——這四樣各講一次就好，同一件事不要換句話說第二遍；(2)【約55字，這段最厚】點出資金主軸並把受惠族群一次列完，而且要寫出盤中的族群變化：資金從哪個族群輪動到哪個族群、誰開盤就衝、誰盤中放量走強、誰到尾盤才翻紅補漲、誰衝高回落；(3)【約30字】點名1檔領漲龍頭，用『龍頭=領頭羊、帶動整個族群』的因果寫法(龍頭股+催化利多+它帶動哪個族群漲停或走強)。數字一律簡化：指數漲跌點取整數(寫「大漲893點」不要寫「上漲893.64點」)、寫了漲跌點就不要再寫收盤點位、成交金額用兆或千億(寫「1.3兆元」不要寫「9840.81億元」)、張數取整數(寫「大買5萬張」不要寫「5.4萬張」)。催化利多優先用營運面事件(漲價、接單、財報、法說、認證通過、產能開出、題材輪動)；當天查不到明確利多就寫「爆量走強」帶過，不要硬掰。不要寫外資/投信買賣超，不要寫散戶觀察或反差收尾",
  "happened": [
    {"title": "已發生事件標題(20字內，寫成一句可讀的結論：主角+動作+受惠，如『國巨調漲電容，帶動被動元件族群』)", "desc": "事件說明(30-40字，一句講完誰因為什麼帶動誰，可帶數字與對象)", "date": "事件日期如6/28或今天"}
  ],
  "upcoming": [
    {"title": "即將到來事件標題(20字內)", "desc": "事件說明(30-40字，一句講清楚是什麼事＋預期影響哪個族群)", "date": "預計日期如7/1或本週四"}
  ]
}
寫作要求（很重要，這決定內容品質）：
1. summary 約 120-140 字（上限 140、寧短勿長），就照上面 (1)~(3) 的骨架寫、三段寫完就停，像下面這種寫法與長度——(1)(2)(3) 每一段的長度也要照抓（這是「風格範例」，長度就是要抓成這樣，只示範結構與語氣，實際內容一定要用今天 Google 查到的真實資料，不要照抄範例裡的數字和個股）：「本日台股在美股費半強漲帶動下，加權指數開高走高，終場大漲893點站上47000點大關，成交金額1.3兆元。資金明顯從金融傳產輪動進AI供應鏈：被動元件開盤即衝、ABF載板盤中放量走強，IC設計尾盤才翻紅補漲。國巨調漲全系列電容成為領頭羊，帶動被動元件多檔亮燈漲停。」
2. happened 列「5 則」最近已經發生的台股重大事件，必須用 Google 搜尋查到真實近期新聞。只選「能解釋某族群為什麼發動的利多題材」，排除薪資／年薪統計、庫藏股買回進度、違約交割、董監改選、股東會、例行公告這類行政面或純風險新聞（除非該事件本身就是當天盤面主軸）。每則都要「龍頭股→帶動族群」連動：點名主角股 + 它帶起的族群 + 催化利多（漲價幅度、分析師調目標價、接大單、打入某大廠供應鏈、受惠某題材、供不應求／急單／產能滿載／旺季拉貨、財報數字、法說會結論等）。desc 壓到 30-40 字，一句講完「誰、因為什麼、帶動誰」，可同時點名對象並帶一個關鍵數字。範例（示範長度與寫法）：「國巨宣布調漲全系列電容價格一到兩成，受惠AI伺服器需求供不應求，帶動被動元件族群多檔漲停」「聯發科獲瑞銀與高盛同步上調目標價至萬元，看好雲端ASIC放量，激勵IC設計族群走強」。不要寫「電子股上漲」這種空泛句，也不要塞滿細節。
3. upcoming 列「5 則」接下來幾天即將發生的具體事件（即將召開的法說會、即將公布的月營收、即將出爐的經濟數據、除權息、產業會議、政策議程等），每則 desc 壓到 30-40 字，一句講清楚「是什麼事＋預期影響哪個族群」，可帶數字與對象。範例：「台積電7/16召開第二季法說會，市場關注CoWoS產能供需、AI需求動能與下半年毛利率展望」。
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

// 籌碼三指標（風度頁三卡用；前端實際經 Worker 讀，這條當備援/驗收）
app.get("/api/chip-indicators", async (req, res) => {
  try {
    const d = await kvGet("chip_indicators");
    if (!d) return res.status(404).json({ ok: false, error: "尚無籌碼資料（每晚 22:10 cron 產生，或先打 /api/tw-rebuild）" });
    res.json(d);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 創新高 high5y：手動觸發（驗證用；🔄 不含此）
// ── 融資維持率 ──────────────────────────────────────────
// 偵察：從 Render 各打一發 TWSE 雙端點，把真實結構攤開（不寫 KV、不改任何東西）
app.get("/api/source-test", async (req, res) => {
  const ymd = String(req.query.date || twTradingDate(1)).replace(/-/g, "");
  const out = { date: ymd };
  for (const [key, url] of [
    ["MI_MARGN", `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${ymd}&selectType=ALL`],
    ["MI_INDEX", `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${ymd}&type=ALLBUT0999`],
  ]) {
    try {
      const raw = await fetchHtml(url);
      let j = null; try { j = JSON.parse(raw); } catch {}
      out[key] = j ? {
        len: raw.length, stat: j.stat || null,
        shape: Array.isArray(j.tables) ? "tables[]" : "fieldsN/dataN",
        tables: twseTables(j).map(t => ({ title: String(t.title || "").slice(0, 40), rows: (t.data || []).length, fields: t.fields })),
      } : { len: (raw || "").length, parse: "FAIL", head: String(raw || "").slice(0, 200) };
    } catch (e) { out[key] = { error: e.message }; }
  }
  try { out.calc = await calcMarginRatio(ymd); } catch (e) { out.calc = { error: e.message }; }
  res.json(out);
});
// ── TradingView scanner 生死測試（日韓美 Top30 前置偵察）──────────────
// 只讀不寫 KV、不動任何現有功能。用法：
//   /api/tv-source-test                  → japan / korea / america 三市場全測＋匯率
//   /api/tv-source-test?market=japan     → 單測一個市場
// 驗什麼：HTTP 通不通、Value.Traded（成交值）排序有沒有料、代號格式、
//         type/subtype 長怎樣（之後濾 ETF 用）、sector 給不給、匯率 Yahoo v8 活不活。
const TV_SCAN_COLUMNS = ["name", "description", "close", "change", "volume", "Value.Traded", "currency", "type", "subtype", "sector", "exchange"];
async function tvScan(market, topN = 5) {
  const t0 = Date.now();
  const body = {
    filter: [{ left: "type", operation: "equal", right: "stock" }],
    options: { lang: "en" },
    markets: [market],
    symbols: { query: { types: [] }, tickers: [] },
    columns: TV_SCAN_COLUMNS,
    sort: { sortBy: "Value.Traded", sortOrder: "desc" },
    range: [0, 50],
  };
  const resp = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Origin": "https://www.tradingview.com",
      "Referer": "https://www.tradingview.com/",
    },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, ms: Date.now() - t0, head: raw.slice(0, 200) };
  let j = null; try { j = JSON.parse(raw); } catch {}
  if (!j || !Array.isArray(j.data)) return { ok: false, status: resp.status, ms: Date.now() - t0, parse: "FAIL", head: raw.slice(0, 200) };
  const rows = j.data.map(r => { const o = { ticker: r.s }; TV_SCAN_COLUMNS.forEach((c, i) => { o[c] = r.d[i]; }); return o; });
  return {
    ok: true, status: resp.status, ms: Date.now() - t0,
    totalCount: j.totalCount ?? null, rows: rows.length,
    nullCols: TV_SCAN_COLUMNS.filter(c => rows.every(r => r[c] == null)),
    top: rows.slice(0, topN).map(r => ({
      ticker: r.ticker, name: r.name, desc: r.description, close: r.close, chg: r.change,
      valueTraded: r["Value.Traded"], cur: r.currency, type: r.type, sub: r.subtype, sector: r.sector,
    })),
  };
}
app.get("/api/tv-source-test", async (req, res) => {
  const markets = req.query.market ? [String(req.query.market)] : ["japan", "korea", "america"];
  const out = { at: new Date().toISOString() };
  for (const m of markets) {
    try { out[m] = await tvScan(m); } catch (e) { out[m] = { ok: false, error: e.message }; }
    await new Promise(r => setTimeout(r, 500)); // 控速
  }
  // 匯率順手驗（Yahoo v8 chart；台幣換算＋備援體系一起測生死）
  out.fx = {};
  for (const pair of ["JPYTWD=X", "KRWTWD=X", "USDTWD=X"]) {
    try {
      const r2 = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair)}?range=1d&interval=1d`, {
        headers: { "User-Agent": BROWSER_UA, "Accept": "application/json" },
      });
      const j2 = r2.ok ? await r2.json() : null;
      const meta = j2 && j2.chart && j2.chart.result && j2.chart.result[0] ? j2.chart.result[0].meta : null;
      out.fx[pair] = meta ? { ok: true, price: meta.regularMarketPrice ?? null, time: meta.regularMarketTime ?? null } : { ok: false, status: r2.status };
    } catch (e) { out.fx[pair] = { ok: false, error: e.message }; }
    await new Promise(r => setTimeout(r, 300)); // 控速
  }
  res.json(out);
});

// 重建/補齊維持率滾動庫（首次＝回溯60天約120發，之後只補缺的）
app.get("/api/tw-margin-ratio", async (req, res) => {
  try { res.json(await buildMarginRatio(+req.query.days || 60)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 讀 KV margin_ratio
app.get("/api/margin-ratio", async (req, res) => {
  try {
    const d = await kvGet("margin_ratio");
    if (!d) return res.status(404).json({ ok: false, error: "尚無 margin_ratio（先打 /api/tw-margin-ratio）" });
    res.json(d);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/tw-high5y", async (req, res) => {
  try { res.json(await buildHigh5y()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 讀 KV high5y（驗證 asOf/count/map）
app.get("/api/high5y", async (req, res) => {
  try {
    const d = await kvGet("high5y");
    if (!d) return res.status(404).json({ ok: false, error: "尚無 high5y（每天台北 0:00 cron 產生，或先打 /api/tw-high5y）" });
    res.json(d);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
// 融資尾根日期：驗證融資到底幾點公布得到（三班都印，比對就知道 21:45 夠不夠早）
function marginTailLog(p) {
  const s = p && p.margin && p.margin.balSeries;
  const tail = Array.isArray(s) && s.length ? s[s.length - 1] : null;
  return tail ? `融資尾根=${tail.d} bal=${tail.v}` : "融資尾根=無";
}

// 籌碼 17:45 班：FinMind 股價/期貨 17:30 更新完 → 當天傍晚就有新 K 棒與外資期貨（融資此時仍為前日值）
cron.schedule("45 9 * * *", async () => {   // 台北 17:45 (UTC 09:45)
  try {
    const p = await buildChipIndicators();
    console.log(`籌碼 cron(17:45) ok=${p && p.ok} ${marginTailLog(p)}`);
  } catch (e) { console.error("籌碼 cron(17:45) error:", e.message); }
});

// 籌碼 21:45 班（搶早）：融資公布時間未確認，先試 21:45；抓不到也無妨，22:10 那班會覆蓋
cron.schedule("45 13 * * *", async () => {   // 台北 21:45 (UTC 13:45)
  try {
    const p = await buildChipIndicators();
    console.log(`籌碼 cron(21:45) ok=${p && p.ok} ${marginTailLog(p)}`);
  } catch (e) { console.error("籌碼 cron(21:45) error:", e.message); }
});

// 籌碼三指標：融資資料公布時間約 21:00~21:30（未確認），22:10 這班是保險，整包重寫會覆蓋 21:45 的結果
cron.schedule("10 14 * * *", async () => {   // 台北 22:10 (UTC 14:10)
  try {
    const p = await buildChipIndicators();
    console.log(`籌碼 cron(22:10) ok=${p && p.ok} ${marginTailLog(p)}`);
  } catch (e) { console.error("籌碼 cron error:", e.message); }
});

cron.schedule("0 10 * * *", async () => {   // 台北 18:00 補跑
  try {
    const r = await buildTwTop50();
    if (r && r.ok && r.data && r.data.length) await buildTwAnalysis(r.data, r.date);
    console.log(`台股 cron(18:00補) date=${r && r.date}`);
  } catch (e) { console.error("台股 cron(18:00補) error:", e.message); }
});

// 創新高 high5y：台北 0:00 獨佔 FinMind 時段算 120 池近五年高
cron.schedule("0 16 * * *", async () => {   // 台北 0:00 (UTC 16:00)
  try {
    const p = await buildHigh5y();
    console.log(`創新高 cron(0:00) ok=${p && p.ok} count=${p && p.count}`);
  } catch (e) { console.error("創新高 cron error:", e.message); }
});

// 健康檢查（UptimeRobot ping 用）
app.get("/", (req, res) => {
  res.send("stockradar-news running");
});

// 個股新聞：即時查詢，不存 KV。
// 品質分層：①黑名單（CMoney 全系列/爆料同學會/個股概覽等）直接丟 ②優質媒體排最前 ③一般來源其後
const NEWS_JUNK = [/股市爆料同學會/, /個股概覽/, /盤中焦點股速報彙整/, /CMoney/i, /投資網誌/];
const NEWS_QUALITY = ["經濟日報", "工商時報", "鉅亨", "cnYES", "聯合新聞網", "UDN", "udn", "自由時報", "中時新聞", "中國時報",
  "TechNews", "科技新報", "MoneyDJ", "財經知識庫", "DIGITIMES", "電子時報", "財訊", "今周刊", "商業周刊",
  "中央社", "ETtoday", "Yahoo", "風傳媒", "遠見", "天下雜誌", "非凡", "三立新聞", "TVBS", "理財周刊"];
function newsTier(item) {
  const t = item.title || "", s = item.src || "";
  if (NEWS_JUNK.some(re => re.test(t) || re.test(s))) return -1;            // 垃圾（含 CMoney 全系列）→ 丟
  if (NEWS_QUALITY.some(q => s.includes(q))) return 0;                       // 優質媒體 → 最前
  return 1;                                                                  // 其他 → 其後
}
app.get("/api/stock-news", async (req, res) => {
  const name = (req.query.name || "").trim();
  const code = (req.query.code || "").trim();

  if (!name && !code) {
    return res.json([{ time: now(), keyword: "", items: [] }]);
  }

  // 「股名 股號」+「純股號」兩組，都要求含股號擋同名詞雜訊。
  // 查詢階段就排除 CMoney（-排除語法）：否則 CMoney 一天十幾篇把 RSS 前20則 quota 吃光，
  // 事後黑名單救不回被擠掉的正常新聞（曾致合晶只剩4則、7/8前全空）。
  const EXCL = " -CMoney";
  const searches = [...new Set(
    [name && code ? `${name} ${code}${EXCL}` : '', code ? `${code}${EXCL}` : ''].filter(q => q.trim())
  )];
  let allItems = [];

  for (const q of searches) {
    try {
      const rss = await fetchGoogleRSS(q);
      const items = parseRSS(rss, 40);
      allItems.push(...items);
    } catch (e) {
      console.log("RSS fail:", q);
    }
  }

  // 分層排序：先層級（優質→一般→CMoney）、同層依時間新→舊；黑名單直接濾除
  const sorted = uniqueNews(allItems)
    .map(it => ({ ...it, _tier: newsTier(it) }))
    .filter(it => it._tier >= 0)
    .sort((a, b) => (a._tier - b._tier) || (new Date(b.pub) - new Date(a.pub)))
    .slice(0, 30)
    .map(({ _tier, ...it }) => it);
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

// ── 內文閱讀器：抓富聯網文章 → Readability 萃取乾淨內文（熱門族群閱讀器用）──
// 白名單只放 money-link（擋 SSRF）；linkedom 造 DOM + Readability 抽本體，只回文字/HTML。
const ARTICLE_ALLOW_RE = /(^|\.)money-link\.com\.tw$/i;
app.get("/api/article", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    let host;
    try { host = new URL(url).hostname; } catch { return res.status(400).json({ ok: false, error: "bad url" }); }
    if (!ARTICLE_ALLOW_RE.test(host)) return res.status(403).json({ ok: false, error: "domain not allowed" });
    const html = await fetchHtml(url);
    if (!html) return res.status(502).json({ ok: false, error: "fetch failed" });
    const { document } = parseHTML(html);

    // 優先：富聯網內文固定在 #NewsMainContent，直接鎖它（快、準，跳過 Readability 評分）
    const main = document.getElementById("NewsMainContent");
    if (main) {
      // 標題用頁面 <title> 去掉「_富聯網」尾綴（querySelector h1 會抓到導覽選單，故不用）
      const title = (document.title || document.querySelector("h1")?.textContent || "").replace(/\s*[_|｜-]\s*富聯網\s*$/, "").trim();
      main.querySelectorAll('script, style, iframe, ins, [id^="onead"]').forEach(el => el.remove());  // 清廣告位/腳本
      main.querySelectorAll("h1, h2").forEach(el => el.remove());   // 移除內文重複主標題（前端已用列表標題顯示）
      const content = main.innerHTML.replace(/<!--[\s\S]*?-->/g, "").trim();   // 清 HTML 註解
      const text = main.textContent.replace(/\s+/g, " ").trim();
      if (content) return res.json({ ok: true, via: "container", title, content, text, excerpt: text.slice(0, 120) });
    }

    // 退回：Readability 通用萃取（找不到容器、或其他來源時）
    const article = new Readability(document).parse();
    if (!article || !article.content) return res.json({ ok: false, error: "parse failed" });
    res.json({
      ok: true,
      via: "readability",
      title: article.title || "",
      content: article.content || "",      // 乾淨內文 HTML（前端用 CSS 隱藏圖片）
      text: article.textContent || "",
      excerpt: article.excerpt || ""
    });
  } catch (e) {
    console.error("/api/article error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
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

// ── 美股 ETF 名單過濾（保險層）──
// 白名單已用 type=CS（普通股）抓，理論上 ETF(type=ETF)進不來；
// 但 Polygon 偶有把 ETF 誤標成 CS 的情況，故再用「高成交值熱門 ETF 名單」擋一層。
// 涵蓋大盤/產業/債券/商品/槓桿反向/ARK/配息/加密貨幣等成交值排得進前50的 ETF。
const US_ETF_SET = new Set([
  // 大盤/綜合
  "SPY","QQQ","QQQM","VOO","IVV","VTI","VT","ITOT","SPLG","RSP","VTV","VUG","IWF","IWD","SCHG","SCHV","MGK","SCHB","SCHX",
  // 小/中型
  "IWM","IWN","IWO","IJR","IJH","MDY","VB","VO","VBR",
  // 國際/區域
  "VEA","VWO","EEM","IEFA","IEMG","EFA","VXUS","ACWI","EWJ","EWZ","FXI","MCHI","KWEB","INDA","EWT","EWY","ASHR","EWG","EWU",
  // 產業 SPDR / 其他產業
  "XLF","XLK","XLE","XLV","XLI","XLU","XLP","XLY","XLB","XLRE","XLC","SMH","SOXX","XBI","IBB","KRE","XOP","XME","GDX","GDXJ","ITB","XRT","XHB","JETS","TAN","ICLN","HACK","ARKK","ARKW","ARKG","ARKF","ARKQ","ARKX",
  // 債券
  "TLT","IEF","SHY","AGG","BND","HYG","LQD","JNK","TIP","BIL","SHV","MBB","VCIT","VCSH","EMB","BKLN","SGOV","TLH","GOVT",
  // 商品/貴金屬
  "GLD","IAU","GLDM","SLV","USO","UNG","DBC","PDBC","SLX","CPER","BOIL","KOLD","UGA",
  // 槓桿/反向（成交值常很高）
  "SQQQ","TQQQ","SOXL","SOXS","SPXL","SPXS","SPXU","UPRO","SDOW","UDOW","TNA","TZA","LABU","LABD","FAS","FAZ","TMF","TMV","NUGT","DUST","YINN","YANG","NVDL","NVDU","TSLL","TSLQ","TSLS","MSTU","MSTX","MSTZ","CONL","FNGU","FNGD","BITX","ETHU","WEBL","DRV","DPST","ERX","ERY","GUSH","DRIP","JNUG","JDST",
  // 波動率
  "UVXY","SVXY","VXX","UVIX","SVIX","VIXY",
  // 配息/品質/動能
  "SCHD","VIG","VYM","DVY","JEPI","JEPQ","DGRO","NOBL","HDV","SDIV","QUAL","USMV","MTUM","VLUE","SPLV","SPHD","DGRW","SPYD",
  // 加密貨幣（現貨/期貨 ETF，現在成交值極高）
  "IBIT","FBTC","GBTC","ETHE","BITO","ARKB","BITB","HODL","EZBC","BTCO","ETHA","BRRR","EZET","FETH","ETHV","ETHW","BTCW","DEFI",
  // Vanguard 產業
  "VGT","VHT","VFH","VDE","VNQ","VPU","VAW","VIS","VCR","VDC","VOX","VYMI","VEU",
]);
const isUsEtf = (code) => US_ETF_SET.has(String(code).toUpperCase());

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
  let complete = true;   // 是否完整抓完（中途沒失敗）
  while (url && pages < 12) {
    const r = await fetch(url);
    if (!r.ok) { complete = false; break; }   // 某頁失敗 → 標記不完整、不快取
    const j = await r.json();
    for (const t of (j.results || [])) {
      const name = t.name || "";
      if (NON_STOCK_RE.test(name)) continue;
      set.add(t.ticker); names[t.ticker] = name;
    }
    pages++;
    url = j.next_url ? `${j.next_url}&apiKey=${POLYGON_KEY}` : null;
  }
  // 只有「完整抓完且數量合理(>3000)」才快取一整天；否則本次用、但不快取，下次重抓
  // （避免某頁失敗把不完整名單快取一天，導致字母後段股如 WDC/XOM 整天被漏掉）
  const fresh = { date: today, set, names };
  if (complete && set.size > 3000) {
    _csCache = fresh;
  }
  console.log(`美股白名單(type=CS)：${set.size} 檔${complete ? "" : "（不完整,未快取）"}`);
  return fresh;
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
      // 白名單只當「名稱來源」，不再過濾誰進榜 → 當天有成交就納入，WDC/XOM 等 W~Z 股不再被漏
      if (isUsEtf(ticker)) continue;            // 排除 ETF（US_ETF_SET 寫死名單，含 SPY/QQQ/TQQQ/SOXL 等高成交，不讓 ETF 霸榜）
      const close = d.c || 0, vol = d.v || 0, vwap = d.vw || close;
      if (close <= 0 || vol <= 0) continue;
      let chgPct = 0;
      const p = prev.ok ? prev.map.get(ticker) : null;
      if (p && p.c > 0) chgPct = ((close - p.c) / p.c) * 100;
      rows.push({
        code: ticker, name: wl.names[ticker] || ticker,   // 名稱來自白名單；抓不到(如限流漏掉的W~Z)則顯示代號
        price: Math.round(close * 100) / 100,
        chg: Math.round(chgPct * 100) / 100,
        dollarVol: Math.round(vwap * vol), vol,
      });
    }
    rows.sort((a, b) => b.dollarVol - a.dollarVol);
    let top50 = rows.slice(0, 50).map((s, i) => ({ rank: i + 1, ...s }));

    // ── NEW / ▲▼ / 在榜天數：一律跟「昨天定榜」比（同日重建不洗 NEW、不動天數）──
    top50 = await applyBoardHistory("us_board_history", date, top50, null);

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

// 測試用：把「昨天定榜」故意移除今天榜的後10檔，讓那10檔變新進榜（驗證新進榜功能）
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
  "summary": "一段像財經晨報的盤後總評(約120-140字，上限140、寧短勿長，通順一整段、不是條列)，照以下順序寫，共三段、寫完就停，每一段的字數也要照抓：(1)【約40字】開場帶到三大指數(道瓊/標普/那斯達克)與費半當天漲跌，接著點出今天成交/資金主軸集中在哪個族群、受惠什麼題材，有族群輪動就寫出來(資金從哪個族群轉進哪個族群)；(2)【約60字】點名3檔今天領漲吸金的龍頭個股(一定帶英文代號，如 NVDA、MU、AVGO)，並寫出它們為什麼吸金(財報數字、分析師上調目標價、AI晶片需求、在AI基礎設施的戰略地位、接單、指數調整等)；當天查不到明確利多的就寫「爆量吸金」帶過，不要硬掰；(3)【約32字】收尾講市場在交易什麼長期故事(如AI長期增長)，並帶一個 nuance(有什麼疑慮、但為什麼信心仍在，如對『賣鏟人』信心強)。數字一律簡化：個股漲跌取整數(寫「大漲5%」不要寫「收高4.92%」)，指數只寫方向或整數百分比，不要寫到小數第二位。不要寫外資/機構買賣超統計",
  "happened": [
    {"title": "已發生事件標題(20字內，寫成一句可讀的結論：主角+動作+受惠，如『AMD獲多家調升目標價，伺服器CPU受惠』)", "desc": "事件說明(30-40字，一句講完誰因為什麼帶動誰，可帶數字與對象)", "date": "事件日期如6/25或今天"}
  ],
  "upcoming": [
    {"title": "即將到來事件標題(20字內)", "desc": "事件說明(30-40字，一句講清楚是什麼事＋預期影響哪個族群)", "date": "預計日期如6/27或本週四"}
  ]
}
寫作要求（很重要，這決定內容品質）：
1. summary 約 120-140 字（上限 140、寧短勿長），就照上面 (1)~(3) 的骨架寫、三段寫完就停，像下面這種寫法與長度——(1)(2)(3) 每一段的長度也要照抓（這是「風格範例」，長度就是要抓成這樣，只示範結構與語氣，實際內容一定要用今天 Google 查到的真實資料，不要照抄範例裡的個股和數字）：「本日美股三大指數與費半齊揚，資金從防禦性類股輪動進AI記憶體與高效能運算晶片。Micron(MU)因財報優於預期大漲，Nvidia(NVDA)、Broadcom(AVGO)受惠AI晶片需求同步吸金。市場續抱AI長期增長故事，儘管有變現疑慮，對『賣鏟人』信心仍強。」
2. happened 列「5 則」最近已經發生的美股重大事件，必須用 Google 搜尋查到真實近期新聞。只選「能解釋某族群或某龍頭為什麼發動的利多題材」，排除股票分割、股息、例行公告這類無關或行政新聞（除非本身就是當天盤面主軸）。每則都要點名主角公司（帶英文代號）+ 它帶起的族群或題材 + 催化利多（財報數字、併購金額、分析師調目標價、接大單、打入某大廠供應鏈、供不應求／訂單能見度高／產能滿載、納入指數、產品發表等）。desc 壓到 30-40 字，一句講完「誰、因為什麼、帶動誰」，可同時點名對象並帶一個關鍵數字。範例（示範長度與寫法）：「Nvidia財報資料中心營收創新高並大幅上調下季財測，AI晶片需求強勁帶動半導體族群齊漲」「AMD獲多家分析師同步上調目標價，看好伺服器CPU市佔提升與AI加速器出貨動能」。不要寫「科技股上漲」這種空泛句，也不要塞滿細節。
3. upcoming 列「5 則」接下來幾天即將發生的具體事件（即將公布的某公司財報、即將召開的會議名稱、即將出爐的經濟數據名稱與日期、Fed 會議等），每則 desc 壓到 30-40 字，一句講清楚「是什麼事＋預期影響哪個族群」，可帶數字與對象。範例：「6月非農就業數據週五出爐，市場關注數據強弱對Fed降息路徑與科技股資金流向的影響」。
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
