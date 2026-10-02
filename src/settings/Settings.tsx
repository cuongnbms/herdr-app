import { useState } from "react";
import { notificationsEnabled, setNotificationsEnabled } from "../notify";

export function Settings() {
  const [open, setOpen] = useState(false);
  const [notify, setNotify] = useState(notificationsEnabled);
  return (
    <div className="settings">
      {open && (
        <div className="popover" role="dialog" aria-label="Settings">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={notify}
              onChange={(e) => {
                setNotify(e.target.checked);
                setNotificationsEnabled(e.target.checked);
              }}
            />
            Notifications
          </label>
          <p className="note">
            For exact chat binding, run <code>herdr integration install claude</code> / <code>pi</code> on each machine.
          </p>
        </div>
      )}
      <button className="gear" aria-label="Settings" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⚙
      </button>
    </div>
  );
}
