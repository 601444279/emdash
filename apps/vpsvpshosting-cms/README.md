# vpsvpshosting CMS

`cms.vpsvpshosting.com` 的 EmDash 后台和站点级 API。该应用是独立的 EmDash + Astro 实现，不依赖 XingTu。

## 职责

- 管理多个独立站点工作区。
- 保存站点域名、已固定的主题版本和安全主题配置。
- 提供受权限和站点范围限制的内容 API。
- 提供只读的公开站点 API，供各 Astro 前台读取已发布内容。

主题代码位于仓库中，数据库不保存或执行上传的主题代码。主题配置不会改写文章正文、文章字段或 SEO 数据。

## 本地检查

```bash
pnpm --filter vpsvpshosting-cms typecheck
pnpm --filter vpsvpshosting-cms build
```

## 部署

`wrangler.jsonc` 包含 Cloudflare D1、KV、R2 和自定义域名绑定。确认已登录正确的 Cloudflare 账号后运行：

```bash
pnpm deploy
```

部署会构建 Astro Worker 并发布到 `cms.vpsvpshosting.com`。

详细架构、站点隔离和前台接入方式见 [站群与 Astro 主题架构](../../docs/vpsvpshosting-emdash-multisite.md)。
