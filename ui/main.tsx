import { createRoot } from "react-dom/client";
import "./viewer.css";
import "./chat.css";
import "./canvas.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
