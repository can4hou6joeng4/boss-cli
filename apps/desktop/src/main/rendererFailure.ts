/**
 * 主窗口界面无法正常显示时的诊断页面。
 *
 * 主窗口以 `show: false` 创建、等 `ready-to-show` 才显示；渲染进程加载失败时该事件不会触发，
 * 用户只会看到「点了没反应」。这里生成一个无脚本、无外链的最小页面，把失败原因留在窗口内。
 * 失败原因可能包含系统路径或开发服务器地址，只在本地窗口内展示，并限制长度。
 */
export function rendererFailurePage(cause: string): string {
  return rendererPage({
    heading: "界面未能加载",
    detail: cause,
    hint: "正式构建请重新运行 npm run build；开发模式请确认渲染进程开发服务器已启动后重启应用。",
  });
}

/** 渲染进程连续崩溃、自动重载预算耗尽时的静态页面；会话数据仍在本地内核。 */
export function rendererCrashPage(cause: string): string {
  return rendererPage({
    heading: "界面进程已停止",
    detail: cause,
    hint: "会话与回合记录保存在本地内核，重新打开应用后可继续。若反复出现，请记录上面的原因并向项目反馈。",
  });
}

/** 只允许内联样式的静态页；所有插入文本先转义，并限制长度。 */
function rendererPage(input: { heading: string; detail: string; hint: string }): string {
  const detail = input.detail.trim().slice(0, 300) || "未知原因";
  const escape = (value: string): string => value.replace(/[&<>"']/g, char => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(input.heading)}</title>
<body style="margin:0;padding:32px;font:14px/1.6 -apple-system,system-ui,sans-serif;background:#111;color:#eee">
<h1 style="margin:0 0 12px;font-size:18px">${escape(input.heading)}</h1>
<p style="margin:0 0 12px;color:#f6c">${escape(detail)}</p>
<p style="margin:0;color:#aaa">${escape(input.hint)}</p>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
