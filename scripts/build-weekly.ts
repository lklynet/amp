import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { buildDatabase } from "./ingest.js"

const runWranglerImport = (databaseName: string, filePath: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("wrangler", ["d1", "import", databaseName, filePath, "--remote"], {
      stdio: "inherit"
    })
    child.on("error", reject)
    child.on("exit", (code: number | null) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`wrangler exited with code ${code}`))
      }
    })
  })

const run = async () => {
  const pgUrl = process.env.MB_PG_URL
  if (!pgUrl) {
    throw new Error("MB_PG_URL is required")
  }
  const databaseName = process.env.D1_DATABASE
  if (!databaseName) {
    throw new Error("D1_DATABASE is required")
  }
  const outDir = process.env.OUT_DIR ?? "out"
  const batchSize = Number(process.env.BATCH_SIZE ?? "5000")
  fs.mkdirSync(outDir, { recursive: true })
  const tempPath = path.join(outDir, `aurral-${Date.now()}.db`)
  const finalPath = path.join(outDir, "aurral.db")
  await buildDatabase({ outputPath: tempPath, batchSize, pgUrl })
  fs.renameSync(tempPath, finalPath)
  await runWranglerImport(databaseName, finalPath)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
