import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
// The Latin subset of the bundled Inter (`@octo/ui/styles.css` declares every subset): fetched now rather than at the
// first layout, so the first paint is already in Inter. Other subsets load when their characters appear.
import interLatin from "@octo/ui/assets/fonts/inter-latin.woff2?url";

const preload = Object.assign(document.createElement("link"), { rel: "preload", as: "font", type: "font/woff2", href: interLatin, crossOrigin: "" });
document.head.append(preload);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
