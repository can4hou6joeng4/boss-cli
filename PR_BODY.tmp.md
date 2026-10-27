## 变更

压缩摘要现在可以独立配置 provider、model 和 reasoning effort，并在手动摘要、自动摘要和上下文溢出恢复中使用同一套解析规则。未配置时沿用当前会话线路与档位；手动摘要请求可单次覆盖模型。覆盖模型只按摘要线路解析，不会先被误当作业务模型校验会话 effort。摘要继续使用隔离的 provider 实例，不携带招聘工具，按摘要模型计算自身预算，并在写入 checkpoint 前重新验证业务模型完整预算。

任务和 checkpoint 会记录实际摘要 provider、model 与 effort。`context/read` 增加摘要线路可用状态，桌面不再把业务线路为 `none` 误判为摘要不可用。

上游依据：Pi Issue [#7553](https://github.com/earendil-works/pi/issues/7553) 与 PR [#11255](https://github.com/earendil-works/pi/pull/11255)。来源状态、固定 commit、许可证与本地采用方式见 `UPSTREAM.md`。

## 验证

- `npm run typecheck`
- `npm run build`
- `uv build --project harness`
- `git diff --check`
- 临时隔离状态与合成 provider 的 ApplicationService 探针：手动和自动摘要均使用独立 provider、摘要模型与指定档位且不携带工具；保存的业务推理档位保持不变，跨 provider 手动模型覆盖不会触发错误的 `REASONING_EFFORT_UNSUPPORTED`；业务 provider 为 `none` 时独立摘要线路仍可用。

探针脚本和测试材料没有提交。未执行真实 Electron 窗口验收或真实模型/招聘平台请求。
