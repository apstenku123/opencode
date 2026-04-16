import path from "path"
import { Global } from "@/global"

export const connectionFile = path.join(Global.Path.data, "copilot-connections.json")

export const legacyCredentialFile = path.join(Global.Path.home, ".copilot", "auth", "credential.json")
export const migrationFile = path.join(Global.Path.data, "copilot-migration.json")
