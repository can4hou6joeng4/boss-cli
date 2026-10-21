import { useEffect, useRef, useState } from "react";
import type { ConnectionCheck, ConnectionReport, ConnectionTarget, PlatformLoginStatus } from "@boss-cli/protocol";
import { connectionReport } from "../data/harnessBridge";

const LABELS: Record<ConnectionCheck["state"], string> = {
  unchecked: "尚未检测", checking: "检测中", ready: "检查通过", failed: "检查失败", blocked: "需要处理", disabled: "离线配置",
};
const AUTH_LABELS: Record<string, string> = { complete: "完整", partial: "不完整", broken: "不可用", missing: "缺失", unknown: "未检测" };

export function ConnectionSettings({ harnessUp, onLogin }: { harnessUp: boolean; onLogin?: () => void }): JSX.Element {
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [login, setLogin] = useState<PlatformLoginStatus | null>(null);
  const version = useRef(0);
  const fetchReport = async (target?: ConnectionTarget): Promise<void> => {
    const current = ++version.current;
    setRequesting(true);
    try {
      const next = await connectionReport(target);
      if (current === version.current) { setReport(next); setError(""); }
    } catch {
      if (current === version.current) setError("无法读取连接检查结果，请确认 Harness 连接后重试。");
    } finally {
      if (current === version.current) setRequesting(false);
    }
  };
  useEffect(() => {
    setReport(null);
    if (harnessUp) void fetchReport();
    return () => { version.current += 1; };
  }, [harnessUp]);
  useEffect(() => {
    if (!window.boss?.platformLogin) return;
    let alive = true, updated = false;
    const unsubscribe = window.boss.onPlatformLogin(next => {
      updated = true;
      if (!alive) return;
      setLogin(next);
      if (["succeeded", "blocked", "failed", "cancelled"].includes(next.state) && harnessUp) void fetchReport();
    });
    void window.boss.platformLogin("status").then(next => { if (alive && !updated) setLogin(next); }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, [harnessUp]);
  const checking = report && Object.values(report).some(check => check.state === "checking");
  useEffect(() => {
    if (!harnessUp || !checking || error) return;
    const timer = setTimeout(() => { void fetchReport(); }, 700);
    return () => clearTimeout(timer);
  }, [harnessUp, checking, report, error]);

  const loginBusy = Boolean(login && ["opening", "waiting", "saving"].includes(login.state));
  const cliBusy = report?.cli.state === "checking" || report?.platform.state === "checking" || loginBusy;
  const rows: Array<{ target: ConnectionTarget; title: string; description: string; check: ConnectionCheck | undefined; action: string }> = [
    { target: "local", title: "本机 CLI", description: "检查可执行文件、协议与本地登录态，不访问平台", check: report?.cli, action: "检查本机" },
    { target: "model", title: "模型服务", description: report?.model.model ? `${report.model.provider} · ${report.model.model}` : "由本机模型配置决定", check: report?.model, action: "测试模型" },
    { target: "platform", title: "BOSS 直聘账号", description: `本地认证信息：${AUTH_LABELS[report?.platform.authState ?? "unknown"] ?? "未检测"}；账号验证结果以标注时间为准`, check: report?.platform, action: "验证账号" },
  ];
  return <>
    <div className="settings-row"><div className="settings-row-copy"><div className="settings-row-title">招聘 Harness</div><p className="settings-row-description">当前桌面进程提供的本机运行状态</p></div><span className={`settings-badge${harnessUp ? " is-connected" : ""}`}><span className="settings-status-dot" />{harnessUp ? "运行中" : "未连接"}</span></div>
    {rows.map(row => <div className="settings-row connection-check-row" key={row.target}>
      <div className="settings-row-copy"><div className="settings-row-title">{row.title}</div><p className="settings-row-description">{row.description}</p>
        <p className="settings-row-description" role="status">{row.check?.summary ?? "尚未检测"}{row.check?.code ? `（${row.check.code}）` : ""}</p>
        {row.check?.checkedAt && <p className="connection-check-time">检查于 {new Date(row.check.checkedAt).toLocaleTimeString()}</p>}
        {row.target === "platform" && <>
          <div className="connection-account-notice" role="note"><strong>按你已有的账号身份登录</strong><p>求职者账号可使用职位检索；查看候选人需要招聘者身份。账号验证通过不代表具备招聘权限。</p>
            {login?.identity && login.identity !== "unknown" && <p>官方页面身份：{login.identity === "jobSeeker" ? "求职者" : "招聘者"}；功能权限以实际工具结果为准。</p>}
          </div>
          {login && login.state !== "idle" && login.summary !== row.check?.summary && <p className="connection-login-status" role="status">{login.summary}{login.code ? `（${login.code}）` : ""}</p>}
        </>}
      </div>
      <div className="connection-check-controls"><span className={`settings-badge${row.check?.state === "ready" ? " is-connected" : ""}`}>{row.target === "platform" && row.check?.state === "ready" ? "账号已验证" : row.check ? LABELS[row.check.state] : "尚未检测"}</span>
        <button type="button" className="settings-button" disabled={!harnessUp || requesting || row.check?.state === "disabled" || (row.target === "model" ? row.check?.state === "checking" : cliBusy)} onClick={() => { void fetchReport(row.target); }}>{row.action}</button>
        {row.target === "platform" && <button type="button" className="settings-button is-primary" disabled={!harnessUp || !onLogin || !window.boss?.platformLogin || (!loginBusy && cliBusy)} onClick={onLogin}>{loginBusy ? "返回会话继续登录" : "在会话中扫码登录"}</button>}
      </div>
    </div>)}
    {error && <p className="connection-check-error" role="alert">{error}<button type="button" className="settings-button" disabled={!harnessUp || requesting} onClick={() => { void fetchReport(); }}>刷新结果</button></p>}
    <div className="settings-note"><div><h3>连接检查</h3><p>“测试模型”会向当前供应商发送一条小请求，可能产生费用。“验证账号”只读取登录账号信息，不发送消息。</p><p>检查结果仅代表标注时间的响应。新建会话默认只读，重启与分支继续保留此限制。</p><p>更改模型配置后重新启动应用。配置方式见 <code>docs/model-integration.md</code>。</p></div></div>
  </>;
}
