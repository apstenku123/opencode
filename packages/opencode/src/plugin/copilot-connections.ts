import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

/**
 * Per-connection exhaustion state matching OpenCode's copilot-connections.json format.
 */
export interface ConnectionState {
  exhaustedUntil?: number | null
  lastTestedAt?: number | null
  label?: string | null
  login?: string | null
}

interface StateFile {
  version: number
  connections: Record<string, ConnectionState>
  preferred?: string | null
}

export interface ResolvedConnection {
  key: string
  label: string
  token: string
  isAvailable: boolean
  exhaustedUntil?: number | null
  isEnterprise: boolean
  enterpriseUrl?: string
}

/**
 * Manages multiple GitHub Copilot connections with round-robin and failover.
 * State is persisted to ~/.local/share/opencode/copilot-connections.json.
 */
export class CopilotConnectionManager {
  private state: StateFile
  private connectionsPath: string | undefined
  private roundRobinIndex = 0

  constructor() {
    this.connectionsPath = this.getConnectionsPath()
    this.state = this.loadState()
  }

  private getConnectionsPath(): string | undefined {
    const dataDir =
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    return join(dataDir, "opencode", "copilot-connections.json")
  }

  private loadState(): StateFile {
    if (!this.connectionsPath)
      return { version: 1, connections: {}, preferred: null }
    try {
      const content = readFileSync(this.connectionsPath, "utf-8")
      return JSON.parse(content)
    } catch {
      return { version: 1, connections: {}, preferred: null }
    }
  }

  private saveState(): void {
    if (!this.connectionsPath) return
    try {
      mkdirSync(dirname(this.connectionsPath), { recursive: true })
      writeFileSync(
        this.connectionsPath,
        JSON.stringify(this.state, null, 2),
        "utf-8",
      )
    } catch {}
  }

  /**
   * Resolve all connections from auth.json merged with connection state.
   */
  async getConnections(
    authEntries: Record<
      string,
      { refresh: string; enterpriseUrl?: string }
    >,
  ): Promise<ResolvedConnection[]> {
    const now = Date.now()
    const connections: ResolvedConnection[] = []

    for (const [key, auth] of Object.entries(authEntries)) {
      if (!key.startsWith("github-copilot")) continue
      const connState = this.state.connections[key]
      const exhaustedUntil = connState?.exhaustedUntil
      const isAvailable = !exhaustedUntil || exhaustedUntil <= now

      connections.push({
        key,
        label: connState?.login || connState?.label || key,
        token: auth.refresh,
        isAvailable,
        exhaustedUntil,
        isEnterprise: !!auth.enterpriseUrl,
        enterpriseUrl: auth.enterpriseUrl,
      })
    }

    // Sort: preferred first, then available first, then by key for stability
    const preferred = this.state.preferred
    connections.sort((a, b) => {
      if (a.key === preferred) return -1
      if (b.key === preferred) return 1
      if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1
      return a.key.localeCompare(b.key)
    })

    return connections
  }

  /**
   * Get the next available connection using round-robin.
   */
  async getNextConnection(
    authEntries: Record<
      string,
      { refresh: string; enterpriseUrl?: string }
    >,
  ): Promise<ResolvedConnection | undefined> {
    const connections = await this.getConnections(authEntries)
    const available = connections.filter((c) => c.isAvailable)
    if (available.length === 0) {
      // All exhausted - return the one that recovers soonest
      const sorted = connections
        .filter((c) => c.exhaustedUntil)
        .sort(
          (a, b) => (a.exhaustedUntil || 0) - (b.exhaustedUntil || 0),
        )
      return sorted[0] || connections[0]
    }

    // Round-robin among available connections
    this.roundRobinIndex = this.roundRobinIndex % available.length
    const selected = available[this.roundRobinIndex]
    this.roundRobinIndex++
    return selected
  }

  /**
   * Mark a connection as exhausted until a specific time.
   */
  setExhaustion(key: string, untilMs: number): void {
    if (!this.state.connections[key]) {
      this.state.connections[key] = {}
    }
    this.state.connections[key].exhaustedUntil = untilMs
    this.state.connections[key].lastTestedAt = Date.now()
    this.saveState()
  }

  /**
   * Clear exhaustion for a connection (e.g., after a successful request).
   */
  clearExhaustion(key: string): void {
    if (this.state.connections[key]) {
      this.state.connections[key].exhaustedUntil = null
      this.saveState()
    }
  }

  /**
   * Set the login for a connection (cached from quota API).
   */
  setLogin(key: string, login: string): void {
    if (!this.state.connections[key]) {
      this.state.connections[key] = {}
    }
    this.state.connections[key].login = login
    this.saveState()
  }

  /**
   * Set the preferred connection.
   */
  setPreferred(key: string): void {
    this.state.preferred = key
    this.saveState()
  }

  /**
   * Get connection state summary for display.
   */
  getConnectionStates(): Record<string, ConnectionState> {
    return { ...this.state.connections }
  }
}
