# New World 官网

writenewworld.com 的源码，独立于 App 构建，部署到 Cloudflare Workers（静态资源）。

```bash
cd site
npm ci
npm run build        # 读取 GitHub 最新正式版，生成 dist/ 与 dist/latest.json
npm test             # 用 tests/fixtures/latest.json 构建并在 wrangler dev 中跑 Playwright
```

- `config.mjs`：站点地址、仓库、许可证与「在线使用」地址（`WEB_APP_URL`）。
- `LATEST_JSON=<文件>`：用本地 JSON 代替 GitHub API；`APP_DIST=<目录>`：把 App 的 Web 构建复制到 `dist/app/`。
- `scripts/images.mjs`：从 `public/app-icon.png` 重新生成 `src/icon-64.png` 和分享预览图 `src/og.png`。
- `notice.html` 内联全部样式和图标，被地区重定向的访客只会请求 `/notice` 这一个地址。

## 部署

`.github/workflows/site.yml` 在推送到 main、发布正式版和 Checks 工作流结束时（Checks 用 `GITHUB_TOKEN` 发布的 Release 不会触发 `release` 事件）测试并部署，后者只在线上 `latest.json` 落后时才重新部署。

GitHub 仓库 Settings → Secrets and variables → Actions 中需要：

| Secret | 内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `CLOUDFLARE_API_TOKEN` | 账户 API Token，见下 |

API Token（My Profile 或 Manage Account → Account API Tokens → Create Token，可从「Edit Cloudflare Workers」模板改起）：

- Account › Workers Scripts › Edit
- Account › Account Settings › Read
- Zone › Workers Routes › Edit，Zone Resources 只选 `writenewworld.com`

首次部署会把 `writenewworld.com` 和 `www.writenewworld.com` 设为该 Worker 的自定义域名；如果这两个主机名已有 DNS 记录，需要先在 DNS 中删除，否则部署会报记录已存在。`www` 由 `worker.js` 301 跳转到主域名。

## 地区重定向规则

把安全规则「连接超时优化」的拦截改为重定向：

1. Cloudflare 控制台 → writenewworld.com → Rules → Overview → Create rule → Redirect Rule。
2. 名称随意，选择 Custom filter expression → Edit expression，填入：
   `(ip.src.country in {"KP" "IR" "CN"} and http.host ne "dl.writenewworld.com" and http.request.uri.path ne "/notice")`
3. Then：Type 选 Static，URL 填 `https://writenewworld.com/notice`，Status code 选 302，不勾选 Preserve query string → Deploy。
4. 重定向规则先于 WAF 自定义规则执行，所以原拦截规则此时只会挡住 `/notice` 本身和 `dl.writenewworld.com`。到 Security → Security rules，把「连接超时优化」的表达式临时加上 `and http.request.uri.path ne "/notice"` 再保存。
5. 用中国大陆的检测节点（如 itdog.cn 的 HTTP 测速）访问 `https://writenewworld.com/`，应返回 302 且 Location 为 `/notice`；访问 `/notice` 应返回 200。也可在 Security → Analytics 里看到这些请求被重定向而非拦截。
6. 确认后删除「连接超时优化」规则。删除后这些地区访问 `dl.writenewworld.com` 将不再被拦截。
