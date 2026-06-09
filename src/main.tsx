import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TrayMenu } from "./components/TrayMenu/TrayMenu";
import "./styles/index.css";

// The frameless tray-menu window loads the same bundle with ?view=tray.
const isTrayMenu = new URLSearchParams(window.location.search).get("view") === "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isTrayMenu ? <TrayMenu /> : <App />}</React.StrictMode>,
);
