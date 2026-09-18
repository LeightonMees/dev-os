import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { StoreProvider } from "./lib/store.tsx";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const baseUrl = params.get("cp") ?? (import.meta.env.VITE_DEV_CONTROL_PLANE_URL as string | undefined) ?? "http://127.0.0.1:47831";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <StoreProvider initialBaseUrl={baseUrl}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
