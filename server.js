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

let sectorNews = [];

function now() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}

// 正確 parse RSS pubDate，回傳台灣時間字串
function parsePubDate(pubDateStr) {
  if (!pubDateStr) return now();
  try {
    const d = new Date(pubDateStr);
    if (isNaN(d.getTime())) return now();
    return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  } catch {
    return now();
  }
}

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
  // 同時抓 title、link、pubDate
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

    // 過濾掉空標題或「Google 新聞」首頁
    if (!rawTitle || rawTitle === "Google 新聞" || rawTitle === "Google News") continue;

    // 來源：標題最後 " - 來源名稱"
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
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.link) || seen.has(item.title)) return false;
    seen.add(item.link);
    seen.add(item.title);
    return true;
  });
}

// 熱門族群：只搜「富聯網 熱門族群」
async function updateSectorNews() {
  console.log(`[${now()}] 更新熱門族群新聞`);

  const rss = await fetchGoogleRSS("富聯網 熱門族群");
  const items = parseRSS(rss);

  sectorNews = [
    {
      time: now(),
      keyword: "富聯網 熱門族群",
      items: uniqueNews(items).slice(0, 20)
    }
  ];

  console.log("熱門族群新聞數量:", sectorNews[0].items.length);
}

// 盤中：週一~五 09:00~14:59 每分鐘
cron.schedule("* 9-14 * * 1-5", async () => {
  await updateSectorNews();
});

// 非盤中：每小時
cron.schedule("0 */1 * * *", async () => {
  await updateSectorNews();
});

// 健康檢查（UptimeRobot ping 用）
app.get("/", (req, res) => {
  res.send("stockradar-news running");
});

// 個股新聞：即時查詢，3 組關鍵字
app.get("/api/stock-news", async (req, res) => {
  const name = (req.query.name || "").trim();
  const code = (req.query.code || "").trim();

  if (!name && !code) {
    return res.json([{ time: now(), keyword: "", items: [] }]);
  }

  const searches = [
    name,
    `${name} ${code}`,
    code
  ].filter(q => q.trim());

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

  res.json([
    {
      time: now(),
      keyword: `${name} ${code}`,
      items: uniqueNews(allItems).slice(0, 15)
    }
  ]);
});

// 熱門族群：從快取回傳
app.get("/api/sectors", (req, res) => {
  res.json(sectorNews);
});

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await updateSectorNews();
});
