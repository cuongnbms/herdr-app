import { useApp } from "../store/app";
import { Modal } from "./ContextMenu";
import { groupPaths, moveNode, resolve, useLayout } from "./groups";
import type { SessionKey } from "./groups";

/** Non-drag way to put a Session into a Group: one button per destination. */
export function MoveToGroupDialog({ sessionKey, onClose }: { sessionKey: SessionKey; onClose: () => void }) {
  const layout = useLayout((s) => s.layout);
  const update = useLayout((s) => s.update);
  const move = (groupId: string | null) => {
    update((l) => {
      const { machines, order } = useApp.getState();
      return moveNode(l, { kind: "session", key: sessionKey }, { kind: "into", groupId }, resolve(l, machines, order).unplaced);
    });
    onClose();
  };
  return (
    <Modal title="Move to group" onClose={onClose}>
      <div className="move-choices">
        <button className="btn" onClick={() => move(null)}>(root)</button>
        {groupPaths(layout).map((g) => (
          <button key={g.id} className="btn" onClick={() => move(g.id)}>{g.path}</button>
        ))}
      </div>
    </Modal>
  );
}
