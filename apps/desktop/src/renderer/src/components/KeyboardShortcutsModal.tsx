import { ModalSurface } from "./ModalSurface";
const GROUPS = [
  { title: "工作区", shortcuts: [
    ["⌘ K", "搜索聊天"], ["⌘ N", "新聊天"], ["⌘ B", "切换项目侧栏"],
    ["⌘ ⌥ B", "切换聊天摘要"], ["⌘ [ / ⌘ ]", "后退 / 前进"], ["⌘ ,", "打开设置"], ["⌘ /", "键盘快捷键"],
  ] },
  { title: "输入", shortcuts: [["Enter", "发送消息"], ["⇧ Enter", "换行"], ["/", "选择快捷指令"], ["@", "选择招聘对象"], ["↑ / ↓", "选择菜单项"], ["Esc", "关闭菜单或弹窗"]] },
  { title: "项目扩展", shortcuts: [["⌘ ⇧ K", "驾驶舱 · 示例"], ["⌘ ;", "快速提问 · 示例"], ["Esc Esc", "会话回溯 · 示例会话"]] },
];
export function KeyboardShortcutsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;
  return <ModalSurface title="键盘快捷键" onClose={onClose} className="shortcuts-dialog">
    <div className="shortcuts-content">{GROUPS.map(group => <section key={group.title}><h3>{group.title}</h3>{group.shortcuts.map(([keys, description]) => <div className="shortcut-row" key={keys}><span>{description}</span><kbd>{keys}</kbd></div>)}</section>)}<p className="dialog-note">Windows / Linux 使用 Ctrl。运行中的任务可通过输入框右侧的停止按钮中断。</p></div>
  </ModalSurface>;
}
