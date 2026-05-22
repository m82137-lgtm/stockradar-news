import express from "express";
import cron from "node-cron";

const app = express();
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

async function updateSectorNews() {
  console.log(`[${now()}] 更新熱門族群新聞`);

  const rss = await fetchGoogleRSS("富聯網 熱門族群");

  sectorNews.unshift({
    time: now(),
    keyword: "富聯網 熱門族群",
    raw: rss.slice(0, 500)
  });

  sectorNews = sectorNews.slice(0, 200);
}

async function updateStockNews() {
  console.log(`[${now()}] 更新個股新聞`);

  const keywords = [
    "台積電",
    "鴻海",
    "廣達",
    "緯創",
    "技嘉"
  ];

  for (const keyword of keywords) {
    const rss = await fetchGoogleRSS(keyword);

    stockNews.unshift({
      time: now(),
      keyword,
      raw: rss.slice(0, 500)
    });
  }

  stockNews = stockNews.slice(0, 500);
}

cron.schedule("* 9-14 * * 1-5", async () => {
  await updateStockNews();
  await updateSectorNews();
});

cron.schedule("0 */3 * * *", async () => {
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
  const keyword = req.query.name || req.query.code;

  if (!keyword) {
    return res.json([]);
  }

  const rss = await fetchGoogleRSS(keyword);

  res.json([
    {
      time: now(),
      keyword,
      items: [...rss.matchAll(/<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>/g)]
        .slice(1, 8)
        .map(m => ({
          title: m[1],
          link: m[2],
          pub: now(),
          src: "Google RSS"
        }))
    }
  ]);
});

     
app.get("/api/sectors", (req, res) => {
  res.json(sectorNews);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
