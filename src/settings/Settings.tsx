import { useState } from "react";
import { notificationsEnabled, setNotificationsEnabled } from "../notify";
import { GearIcon, SearchIcon } from "../ui/icons";

export function Settings() {
  const [open, setOpen] = useState(false);
  const [notify, setNotify] = useState(notificationsEnabled);
  return (
    <div className="settings">
      {open && (
        <div className="popover" role="dialog" aria-label="Settings">
          <div className="popover-title">Settings</div>
          <label className="switch">
            <span>Notifications</span>
            <input
              type="checkbox"
              role="switch"
              checked={notify}
              onChange={(e) => {
                setNotify(e.target.checked);
                setNotificationsEnabled(e.target.checked);
              }}
            />
          </label>
          <p className="note">
            For exact chat binding, run <code>herdr integration install claude</code> / <code>pi</code> on each machine.
          </p>
        </div>
      )}
      <button className="icon-btn" aria-label="Settings" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <GearIcon />
      </button>
      <span className="settings-hint">
        <SearchIcon /> Jump <kbd>⌘K</kbd>
      </span>
    </div>
  );
}
