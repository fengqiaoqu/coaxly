/* 哄着学 Coaxly · 浏览器兼容层
 * Chrome / Edge 提供 chrome.* 命名空间；Safari 的 Web Extension 用 browser.*（新版也认 chrome.*）。
 * 这里统一成 chrome.*：哪个环境都能跑，扩展其余代码不用改。
 */
(() => {
  'use strict';
  const g = globalThis;
  if (!g.chrome && g.browser) g.chrome = g.browser;
})();
