import { codex, type Provider } from "./chat-providers";
import { claude } from "./chat-claude";

/** Order is the order of the provider selector. */
export const PROVIDERS: Record<string, Provider> = { codex, claude };
