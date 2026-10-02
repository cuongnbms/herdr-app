import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { useTheme } from "./settings/theme";

// Before the first paint, so a light theme does not flash dark.
document.documentElement.dataset.theme = useTheme.getState().theme;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
