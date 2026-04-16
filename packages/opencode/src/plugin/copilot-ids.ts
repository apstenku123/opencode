import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir, platform } from "node:os"

let sessionId: string | undefined
let machineId: string | undefined

export function getCopilotSessionId(): string {
  if (!sessionId) {
    sessionId = randomUUID()
  }
  return sessionId
}

export function getCopilotMachineId(): string {
  if (machineId) return machineId

  const deviceIdPath = getDeviceIdPath()
  if (deviceIdPath) {
    try {
      const id = readFileSync(deviceIdPath, "utf-8").trim().toLowerCase()
      if (id) {
        machineId = id
        return machineId
      }
    } catch {}

    // File doesn't exist - generate and save (matching CLI behavior)
    const id = randomUUID().toLowerCase()
    try {
      const dir = join(deviceIdPath, "..")
      mkdirSync(dir, { recursive: true })
      writeFileSync(deviceIdPath, id, "utf-8")
    } catch {}
    machineId = id
    return machineId
  }

  // Fallback: random UUID
  machineId = randomUUID()
  return machineId
}

function getDeviceIdPath(): string | undefined {
  const home = homedir()
  const plat = platform()

  if (plat === "darwin") {
    return join(home, "Library", "Application Support", "Microsoft", "DeveloperTools", "deviceid")
  }
  if (plat === "win32") {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      return join(localAppData, "Microsoft", "DeveloperTools", "deviceid")
    }
    return join(home, "AppData", "Local", "Microsoft", "DeveloperTools", "deviceid")
  }
  // Linux
  const cacheDir = process.env.XDG_CACHE_HOME || join(home, ".cache")
  return join(cacheDir, "Microsoft", "DeveloperTools", "deviceid")
}
