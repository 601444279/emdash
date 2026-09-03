# vpsvpshosting EmDash 站群与 Astro 主题架构

本文件记录 `vpsvpshosting.com` 的独立 EmDash 站群实现。它不属于 XingTu，也不复用 XingTu 的代码、主题、内容模型或部署流程。

## 组成

```
cms.vpsvpshosting.com
  └─ EmDash CMS Worker：后台、受保护的管理 API、站点级 API

vpsvpshosting.com
  └─ Astro Worker：公开前台；根据 CMS 返回的站点和主题配置渲染页面
```

CMS 位于 `apps/vpsvpshosting-cms`，前台首站位于 `sites/vpsvpshosting`。后续每个公开站点都应使用独立 Astro Worker，并设置自己的 `CMS_SITE_KEY`；不能通过复制数据库或直接读取其他站点的内容实现站群。

## 站点隔离

数据库迁移 `074` 至 `077` 建立了站点、域名、站点内容映射、主题历史和 API 令牌站点范围。

| 数据 | 隔离方式 |
| --- | --- |
| 内容 | `_emdash_site_content` 将每条内容绑定到一个站点和集合 |
| 域名 | `_emdash_site_domains` 归属一个站点 |
| 主题 | `_emdash_sites` 固定主题 ID、版本和配置；历史记录保存在 `_emdash_site_theme_history` |
| API 令牌 | `site_keys` 限制令牌可访问的站点 |

旧单站内容会归入 `legacy` 站点，避免迁移后内容丢失。站点级管理 API 使用 `/_emdash/api/sites/:siteKey/...`，公开前台只读取 `/_emdash/api/public/sites/:siteKey/...`。

## Astro 主题

主题注册表在 `packages/core/src/themes/index.ts`，共享 Astro 渲染组件位于 `packages/astro-themes`。主题是受版本控制的代码包，数据库只保存主题 ID、版本和经过验证的配置值。每个公开站点依赖这个共享包，不复制主题壳或文章卡片代码。

主题声明覆盖的页面类型：

- `home`
- `post`
- `category`
- `search`
- `archive`
- `page`

当前提供 `editorial` 与 `catalog` 两套主题。可配置项为配色、字体、文章卡片、导航和页脚布局。主题切换、版本升级和回滚只变更站点主题配置，不修改文章正文、文章字段或 SEO 数据。

不要把主题代码上传到数据库，也不要增加任意 CSS 或任意脚本注入入口。新增主题时，应在注册表中声明允许的配置和值，并在 `packages/astro-themes` 中实现对应的静态 Astro 页面组件。

## 首站运行与部署

CMS 使用 D1、KV 和 R2；公开前台使用 Cloudflare Worker，并通过下列环境变量读取 CMS：

| 应用 | 变量 | 用途 |
| --- | --- | --- |
| `apps/vpsvpshosting-cms` | `EMDASH_SITE_URL` | CMS 自身公开地址 |
| `sites/vpsvpshosting` | `CMS_BASE_URL` | CMS 公共 API 地址 |
| `sites/vpsvpshosting` | `CMS_SITE_KEY` | 当前前台对应的站点键 |

在仓库根目录完成依赖安装和构建后，分别部署：

```bash
pnpm --filter vpsvpshosting-cms build
pnpm --dir sites/vpsvpshosting build

pnpm --dir apps/vpsvpshosting-cms deploy
pnpm --dir sites/vpsvpshosting deploy
```

部署后检查 CMS 后台、公开首页和站点级公开 API。未登录访问 `/_emdash/api/themes` 应返回 `401`；该接口仅提供主题注册表给后台使用。

## 已知边界

- 当前公开前台已实现首页、文章页和搜索页，并按主题配置应用配色、字体、卡片、导航和页脚样式。
- 后续主题开发优先补齐分类、归档、独立页、菜单和 SEO 输出的站点级渲染；不通过新增文章展示字段实现版式差异。
- `bestvpsserver.com` 保持独立，后续可创建为另一个站点工作区后再接入。
