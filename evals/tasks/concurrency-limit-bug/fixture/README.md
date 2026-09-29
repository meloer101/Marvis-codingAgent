# site-crawler

批量抓取一组 URL，输出每个页面的状态码和大小。

```
npm run crawl -- urls.txt
```

- `src/crawl.js` — 抓取逻辑，最多同时 4 个请求，单个页面失败不影响其他页面
- `src/pool.js` — `mapLimit`，通用的并发控制工具
- `src/cli.js` — 命令行入口

## 测试

```
npm test
```
