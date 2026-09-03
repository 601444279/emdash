# EmDash Astro 主题渲染包

此包存放由 EmDash 主题注册表控制的 Astro 前台渲染组件。主题源代码随前台 Worker 构建并部署，数据库只保存已验证的主题 ID、版本和安全配置。

公开站点通过 `ThemeShell.astro` 提供页面壳，并用 `PostCard.astro` 渲染文章列表。站点本身负责从站点级公开 API 读取内容；组件不读取数据库，也不执行后台保存的代码或 CSS。

新增主题时，先在 `packages/core/src/themes/index.ts` 声明主题 ID、版本、页面契约和允许的设置，再在本包中实现对应的静态 Astro 渲染。不要将 XingTu 的主题、内容或部署逻辑放入此包。
