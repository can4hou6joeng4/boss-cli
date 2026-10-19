import React, { useState } from "react";
import { IconCheck } from "./Icons";
import { ModalSurface } from "./ModalSurface";
import { MOCK_COCKPIT_DATA } from "../data/mockData";

export interface CockpitModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = "Summary" | "Safety" | "Verify" | "Model" | "Context" | "Trace" | "MCP" | "Advisory";

export const CockpitModal: React.FC<CockpitModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<TabKey>("Summary");

  if (!isOpen) return null;

  const data = MOCK_COCKPIT_DATA;

  return (
    <ModalSurface title="运行状态透视 · 示例" onClose={onClose} className="cockpit-dialog">
      <p className="dialog-note cockpit-notice">示例数据，用于展示运行指标布局。当前尚未连接实时指标服务。</p>
        {/* 8 个 Tab 标签栏 */}
        <div className="cockpit-tabs-row">
          {(
            [
              "Summary",
              "Safety",
              "Verify",
              "Model",
              "Context",
              "Trace",
              "MCP",
              "Advisory",
            ] as TabKey[]
          ).map((tab) => (
            <button
              key={tab}
              className={`cockpit-tab-btn ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab 内容区 */}
        <div className="cockpit-body">
          {activeTab === "Summary" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--accent-color)" }}>
                  当前会话配置
                </div>
                <div style={{ fontSize: 13, lineHeight: 2 }}>
                  <div><b>模型路由：</b>{data.summary.model}</div>
                  <div><b>认知星域：</b>{data.summary.domain}</div>
                  <div><b>执行轮次：</b>{data.summary.turns} 轮迭代</div>
                </div>
              </div>

              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--accent-green)" }}>
                  资源消耗与命中
                </div>
                <div style={{ fontSize: 13, lineHeight: 2 }}>
                  <div><b>Token 用量：</b>{data.summary.totalTokens}</div>
                  <div><b>前缀缓存命中率：</b>{data.summary.cacheHitRate}</div>
                  <div><b>累计成本：</b>{data.summary.totalCost}</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "Safety" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>死循环防护 (Doom Loop Guard)</div>
                <div style={{ color: "var(--accent-green)", fontSize: 13 }}>
                  ● 未检测到死循环风险，执行链路处于健康周期
                </div>
              </div>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>沙箱权限</div>
                <div style={{ fontSize: 13 }}>{data.safety.sandboxMode}</div>
              </div>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>活跃拦截 Hook</div>
                {data.safety.activeHooks.map((h) => (
                  <div key={h} style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
                    <IconCheck size={12} style={{ color: "var(--accent-green)" }} />
                    <span>{h}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === "Verify" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, color: "var(--accent-green)" }}>
                  RED 闸门状态：{data.verify.redGateStatus}
                </div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  证据得分：{data.verify.evidenceScore}
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                  交付就绪度：{data.verify.deliveryReadiness}
                </div>
              </div>
            </div>
          )}

          {activeTab === "Model" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>前缀缓存与推测解码</div>
                <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                  <div><b>输入 Token：</b>{data.model.inputTokens}</div>
                  <div><b>缓存读取 (Cache Read)：</b>{data.model.cacheReadTokens}</div>
                  <div><b>新增缓存 (Cache Create)：</b>{data.model.cacheCreateTokens}</div>
                  <div><b>输出 Token：</b>{data.model.outputTokens}</div>
                  <div><b>推测解码命中：</b>{data.model.speculativeDecodeRate}</div>
                  <div><b>路由通道：</b>{data.model.routerPath}</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "Context" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="tool-block" style={{ padding: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  上下文占用 ({data.context.percentUsed}%)
                </div>
                <div className="ctx-bar" style={{ width: "100%", height: 10, borderRadius: 5 }}>
                  <div
                    className="ctx-fill"
                    style={{ width: `${data.context.percentUsed}%` }}
                  />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                  已消耗 {data.context.currentTokens} / 上限 {data.context.maxTokens} Tokens · 钉定锚点: {data.context.pinnedAnchors} · 压缩次数: {data.context.compactionCount}
                </div>
              </div>
            </div>
          )}

          {activeTab === "Trace" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 4 }}>
                事件时间线瀑布流（Event Timeline）
              </div>
              {data.trace.map((t, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: "var(--accent-color)", fontWeight: 600 }}>
                      Turn {t.turn}
                    </span>
                    <span style={{ color: "var(--text-faint)" }}>[{t.type}]</span>
                    <span style={{ fontWeight: 500 }}>{t.name}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--accent-cyan)" }}>{t.latency}</span>
                    <span style={{ color: t.status === "ok" ? "var(--accent-green)" : "var(--accent-warning)" }}>
                      {t.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === "MCP" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {data.mcp.map((server) => (
                <div
                  key={server.name}
                  className="tool-block"
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px" }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{server.name}</div>
                    <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                      可用工具数: {server.toolsCount}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 12 }}>
                    <div style={{ color: "var(--accent-green)", fontWeight: 600 }}>
                      ● {server.status}
                    </div>
                    <div style={{ color: "var(--text-faint)" }}>{server.ping}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === "Advisory" && (
            <div className="tool-block" style={{ padding: 14 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>提醒投放与建议效能统计</div>
              <div style={{ fontSize: 13, lineHeight: 2 }}>
                <div><b>总计投放提醒：</b>{data.advisory.rendered} 次</div>
                <div><b>模型采纳：</b>{data.advisory.adopted} 次</div>
                <div><b>忽略与丢弃：</b>{data.advisory.dismissed} 次</div>
                <div><b>整体效能得分：</b>{data.advisory.efficiencyScore}</div>
              </div>
            </div>
          )}
        </div>
    </ModalSurface>
  );
};
