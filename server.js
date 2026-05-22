import express from "express";
import cron from "node-cron";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 3000;

let stockNews = [];
let sectorNews = [];

function now() {
  return new Date().toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei"
  });
}

async function fetchGoogleRSS(keyword) {

  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;

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

  return [...rss.matchAll(/<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>/g)]
    .slice(1, 20)
    .map(m => ({
      title: m[1],
      link: m[2],
      pub: now(),
      src: "Google RSS"
    }));
}

function uniqueNews(items) {

  const seen = new Set();

  return items.filter(item => {

    if (seen.has(item.link)) {
      return false;
    }

    seen.add(item.link);
    return true;
  });
}

async function updateSectorNews() {

  console.log(`[${now()}] 更新熱門族群新聞`);

  const searches = [
    "熱門族群"
  ];

  let allItems = [];

  for (const keyword of searches) {

    const rss = await fetchGoogleRSS(keyword);

    const items = parseRSS(rss);

    allItems.push(...items);
  }

  sectorNews = [
    {
      time: now(),
      keyword: "熱門族群",
      items: uniqueNews(allItems).slice(0, 20)
    }
  ];

  console.log("熱門族群新聞數量:", sectorNews[0].items.length);
}

async function updateStockNews() {

  console.log(`[${now()}] 更新個股新聞`);

  const keywords = [
    { name: "台積電", code: "2330" },
    { name: "鴻海", code: "2317" },
    { name: "廣達", code: "2382" },
    { name: "緯創", code: "3231" },
    { name: "技嘉", code: "2376" }
  ];

  stockNews = [];

  for (const stock of keywords) {

    const searches = [
      stock.name,
      stock.code,
      `${stock.name} ${stock.code}`,
      `${stock.name} 股票`,
      `${stock.code} 股票`
    ];

    let allItems = [];

    for (const q of searches) {

      const rss = await fetchGoogleRSS(q);

      const items = parseRSS(rss);

      allItems.push(...items);
    }

    stockNews.push({
      time: now(),
      keyword: `${stock.name} ${stock.code}`,
      items: uniqueNews(allItems).slice(0, 15)
    });

    console.log(stock.name, "新聞數:", allItems.length);
  }
}

cron.schedule("* 9-14 * * 1-5", async () => {

  await updateStockNews();
  await updateSectorNews();

});

cron.schedule("0 */1 * * *", async () => {

  await updateStockNews();
  await updateSectorNews();

});

app.get("/", (req, res) => {

  res.send("stockradar-news running");
});

app.get("/api/stocks", (req, res) => {

  res.json(stockNews);
});

app.get("/api/stock-news", async (req, res) => {

  const name = req.query.name || "";
  const code = req.query.code || "";

  const searches = [
    name,
    code,
    `${name} ${code}`,
    `${name} 股票`,
    `${code} 股票`
  ];

  let allItems = [];

  for (const q of searches) {

    if (!q.trim()) continue;

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

app.get("/api/sectors", (req, res) => {

  res.json(sectorNews);
});

app.listen(PORT, async () => {

  console.log(`Server running on ${PORT}`);

  await updateStockNews();
  await updateSectorNews();
});
