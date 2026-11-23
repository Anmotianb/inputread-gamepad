# 隐私说明

本扩展不收集、不上传任何个人数据。

- **不联网**：扩展本身不发送网络请求，不包含统计、广告或远程配置。
- **不读取书籍内容**：只在页面上点击已有按钮、滚动页面；不保存或上传正文、生词、账号信息。
- **本地存储**：仅使用 `chrome.storage.session` 记住“由手柄打开的图片标签页”的标签页编号，用于按 RB 返回；标签页关闭或浏览器退出即清除。
- **手柄数据**：通过浏览器 Gamepad API 在本地读取，不存储、不发送。
- **站点访问范围**：`https://inputread.site/*`（阅读页），以及 `https://www.google.com/search*`、`https://www.google.com/imgres*`、`https://www.google.com.hk/search*`、`https://www.google.com.hk/imgres*`、`https://www.bing.com/images/*`（图片页的滚动与返回）。普通标签页不会响应手柄。
- **第三方页面**：点击“看图片”后打开的是 Google/Bing 的图片搜索页，这些页面由对应服务商提供，适用其隐私政策。

问题或建议请在本仓库开 Issue。
