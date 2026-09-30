import { agentHome, pauseAgentHooks } from "./agent-inbox.js";

/** `vscode:uninstall`: VS Code runs this (best effort, without UI) after the extension
 * is fully removed. Vendor configuration is deliberately NOT edited without the
 * user's confirmation; the Stack Stats hook is only paused so any remaining entries
 * record nothing. "Disconnect All Agent Integrations" before uninstalling removes
 * them. Another editor still running Stack Stats re-enables its own state. */
try { pauseAgentHooks(agentHome()); } catch { /* Nothing to clean up. */ }
