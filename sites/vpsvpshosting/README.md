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

生产站点使用 `ranked@1.0.0`。该主题面向 VPS 评测、比较和榜单内容，包含研究导览条、编号文章卡片、双栏文章页和移动端单栏布局。`editorial` 已被删除，前台代码和 CMS 配置都不能再引用该主题 ID。

## 首站样板要求

`vpsvpshosting.com` 是共享 `ranked` 主题的验证站。修改共享组件前，先在本项目检查以下页面和内容状态：

- 首页、文章归档、分类、搜索、文章页和独立页。
- 长标题、长摘要、无封面图、空内容列表和移动端窄屏。
- CMS 发布后前台内容更新，以及主题配置与 HTML `data-theme`、`data-palette`、`data-font` 的一致性。

页面结构可以参考公开评测站的分类、比较和信任信息组织方式，但不得复制第三方代码、图片、文案、商标或样式资源。

## 本地检查与部署

```bash
pnpm typecheck
pnpm build
pnpm deploy
```

部署后访问 `https://vpsvpshosting.com/`，并确认 HTML 的 `data-theme`、`data-palette` 和 `data-font` 与后台站点配置一致。

详细架构见 [站群与 Astro 主题架构](../../docs/vpsvpshosting-emdash-multisite.md)。
