# stockradar-news-render

Render 新聞服務：

- 個股新聞：Google RSS，只搜尋「股名」
- 熱門族群：Google RSS，只搜尋「富聯網 熱門族群」
- 盤中每分鐘檢查，但每檔 1 小時 cooldown
- 重複新聞不寫入 SQLite
- 非盤中每 3 小時補抓一次

## Render 設定

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

Environment Variables:

```text
DB_PATH=/var/data/stockradar_news.db
```

建議在 Render 加 Persistent Disk，掛載路徑：

```text
/var/data
```

## API

健康檢查：

```text
/health
```

同步股票清單：

```http
POST /api/stocks
Content-Type: application/json

{
  "stocks": [
    { "code": "2330", "name": "台積電" },
    { "code": "2327", "name": "國巨" }
  ]
}
```

讀個股新聞：

```text
/api/stock-news?code=2330
```

手動刷新單一股票：

```text
/api/refresh-stock-news-code?code=2330&name=台積電&force=1
```

讀熱門族群：

```text
/api/sectors
```

手動刷新熱門族群：

```text
/api/refresh-sectors
```

測 Google RSS：

```text
/api/debug-google-rss?name=台積電
```
