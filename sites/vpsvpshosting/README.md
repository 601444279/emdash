# vpsvpshosting Astro 前台

`vpsvpshosting.com` 的公开 Astro 前台。它从 `cms.vpsvpshosting.com` 的站点级公开 API 读取已发布内容和主题配置，并在 Cloudflare Worker 上渲染。

该前台只负责展示。内容、SEO、站点主题选择和权限均由 EmDash CMS 管理；不读取 XingTu 数据，也不修改 EmDash 的内容模型。

## 必需配置

`wrangler.jsonc` 中的变量必须指向对应的 CMS 和站点：

```json
{
	"CMS_BASE_URL": "https://cms.vpsvpshosting.com",
	"CMS_SITE_KEY": "vpsvpshosting"
}
```

新站点应创建新的 Astro 前台目录和 Worker，并使用该站点自己的 `CMS_SITE_KEY`。

## 主题行为

前台依据 CMS 返回的主题 ID、固定版本和安全配置渲染页面。当前支持的配置包括配色、字体、文章卡片、导航和页脚布局。主题只改变页面结构和样式，不依赖新增文章展示字段。

## 本地检查与部署

```bash
pnpm typecheck
pnpm build
pnpm deploy
```

部署后访问 `https://vpsvpshosting.com/`，并确认 HTML 的 `data-theme`、`data-palette` 和 `data-font` 与后台站点配置一致。

详细架构见 [站群与 Astro 主题架构](../../docs/vpsvpshosting-emdash-multisite.md)。
