import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "./style.css";

// The dashboard (ADR 0012): one React app in the page's root, a client of Lasso's /api.
createRoot(document.getElementById("root")!).render(<App />);
