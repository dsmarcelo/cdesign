# src/shot.ts

- ShotOpts · type · L6-L15 — type ShotOpts = { url: string; selector?: string; // CSS selector; absent = the page width: number; // viewport width in CSS px theme?: "light" | "dark"; format: "webp" | "jpeg" | "png"; maxEdge: number; // longest side of the image in px (Claude downsizes anything above ~1568) maxHeight: number; // page shots taller than this (CSS px) are cropped from the top; 0 = never crop y: number; // page shots: start this many CSS px from the top };
- ShotResult · type · L16-L16 — type ShotResult = { data: Buffer; mime: string; width: number; height: number; note: string };
- findChrome · function · L29-L35 — function findChrome()
- screenshot · function · L37-L64 — async function screenshot(o: ShotOpts): Promise<ShotResult>
- capture · function · L66-L151 — async function capture(wsUrl: string, o: ShotOpts): Promise<ShotResult>
- send · function · L80-L81 — send = (method: string, params: object = {}, sessionId?: string)
- until · function · L82-L83 — until = (method: string, ms: number)
- cmd · function · L88-L88 — cmd = (method: string, params: object = {})
- ev · function · L89-L93 — ev = async (expression: string)
