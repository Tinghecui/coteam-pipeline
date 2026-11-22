// The agent CLIs the engine can run, by the name the config uses (agents.executor, agents.reviewer).
import { CLAUDE } from "./claude.mjs"
import { CODEX } from "./codex.mjs"

export const AGENTS = { claude: CLAUDE, codex: CODEX }
export const AGENT_NAMES = Object.keys(AGENTS)
