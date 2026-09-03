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

数据库迁移 `074` 至 `078` 建立了站点、域名、站点内容映射、主题历史、API 令牌站点范围和站点菜单映射。

| 数据     | 隔离方式                                                                             |
| -------- | ------------------------------------------------------------------------------------ |
| 内容     | `_emdash_site_content` 将每条内容绑定到一个站点和集合                                |
| 域名     | `_emdash_site_domains` 归属一个站点                                                  |
| 主题     | `_emdash_sites` 固定主题 ID、版本和配置；历史记录保存在 `_emdash_site_theme_history` |
| API 令牌 | `site_keys` 限制令牌可访问的站点                                                     |
| 菜单     | `_emdash_site_menus` 将一个站点的主导航绑定到指定菜单                                |

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

当前提供 `editorial`、`catalog` 与 `ranked` 三套主题。`ranked` 面向评测、比较和榜单型站点，使用研究导览条、编号文章卡片、双栏文章页和移动端单栏阅读布局。它只读取已有的标题、摘要、发布日期、正文和菜单，不要求增加文章字段。

可配置项为配色、字体、文章卡片、导航和页脚布局。主题切换、版本升级和回滚只变更站点主题配置，不修改文章正文、文章字段或 SEO 数据。

`ranked` 的视觉参考来自公开评测站常见的内容组织方式：先给出阅读方向，再展示近期研究和验证信息。主题代码没有使用参考网站的名称、商标、图片、文案、图标或样式资源。

在 **Sites** 页面打开主题管理后，可为站点选择已有菜单。前台只读取该站点绑定的主导航，并且公开接口仅返回站内自定义链接；以 `//` 开头的协议相对链接不会进入主题导航。

不要把主题代码上传到数据库，也不要增加任意 CSS 或任意脚本注入入口。新增主题时，应在注册表中声明允许的配置和值，并在 `packages/astro-themes` 中实现对应的静态 Astro 页面组件。

## 首站运行与部署

CMS 使用 D1、KV 和 R2；公开前台使用 Cloudflare Worker，并通过下列环境变量读取 CMS：

| 应用                     | 变量              | 用途                 |
| ------------------------ | ----------------- | -------------------- |
| `apps/vpsvpshosting-cms` | `EMDASH_SITE_URL` | CMS 自身公开地址     |
| `sites/vpsvpshosting`    | `CMS_BASE_URL`    | CMS 公共 API 地址    |
| `sites/vpsvpshosting`    | `CMS_SITE_KEY`    | 当前前台对应的站点键 |

在仓库根目录完成依赖安装和构建后，分别部署：

```bash
pnpm --filter vpsvpshosting-cms build
pnpm --dir sites/vpsvpshosting build

pnpm --dir apps/vpsvpshosting-cms deploy
pnpm --dir sites/vpsvpshosting deploy
```

部署后检查 CMS 后台、公开首页和站点级公开 API。未登录访问 `/_emdash/api/themes` 应返回 `401`；该接口仅提供主题注册表给后台使用。

## 已知边界

- 当前公开前台已实现首页、文章页、文章归档、分类页、独立页和搜索页，并按主题配置应用配色、字体、卡片、导航和页脚样式。主题壳同时输出规范链接和基础社交元数据。
- 主题不通过新增文章展示字段实现版式差异。
- `bestvpsserver.com` 保持独立，后续可创建为另一个站点工作区后再接入。
