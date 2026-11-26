import { createRoot } from "react-dom/client";
import "./viewer.css";
import "./chat.css";
import "./map.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
