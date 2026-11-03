/**
 * 主窗口界面加载失败时的诊断页面。
 *
 * 主窗口以 `show: false` 创建、等 `ready-to-show` 才显示；渲染进程加载失败时该事件不会触发，
 * 用户只会看到「点了没反应」。这里生成一个无脚本、无外链的最小页面，把失败原因留在窗口内。
 * 失败原因可能包含系统路径或开发服务器地址，只在本地窗口内展示，并限制长度。
 */
export function rendererFailurePage(cause: string): string {
  const detail = cause.trim().slice(0, 300) || "未知原因";
  const escape = (value: string): string => value.replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>界面未能加载</title>
<body style="margin:0;padding:32px;font:14px/1.6 -apple-system,system-ui,sans-serif;background:#111;color:#eee">
<h1 style="margin:0 0 12px;font-size:18px">界面未能加载</h1>
<p style="margin:0 0 12px;color:#f6c">${escape(detail)}</p>
<p style="margin:0;color:#aaa">正式构建请重新运行 <code>npm run build</code>；开发模式请确认渲染进程开发服务器已启动后重启应用。</p>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
