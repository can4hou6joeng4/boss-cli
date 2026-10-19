import { ModalSurface } from "./ModalSurface";
import { IconUndo } from "./Icons";
export function RevertConfirmModal({ isOpen, onClose, onConfirm, fileCount = 0 }: { isOpen: boolean; onClose: () => void; onConfirm: () => void; fileCount?: number }) {
  if (!isOpen) return null;
  return <ModalSurface title="重置示例变更" onClose={onClose} className="compact-dialog">
    <div className="dialog-form"><IconUndo size={26} /><p>从当前界面移除这 {fileCount} 个文件的示例变更卡片。磁盘中的文件不会被修改。</p><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="solid-button" onClick={() => { onConfirm(); onClose(); }}>重置示例</button></div></div>
  </ModalSurface>;
}
