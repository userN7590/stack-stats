import { initializeConfig, loadConfig, configPath } from "./config.js";
import { localDateKey } from "@stack-stats/core";
import { readFile } from "node:fs/promises";

const command = process.argv[2] ?? "help";

if (["telemetry", "events", "compare", "ingest"].includes(command)) {
  const config = loadConfig();
  const value = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  let response: Response;
  if (command === "ingest") {
    const path = value("--file");
    if (!path) throw new Error("Usage: ingest --file normalized-telemetry-batch.json");
    response = await fetch(`http://127.0.0.1:${config.port}/v2/events`, { method: "POST", headers,
      body: await readFile(path, "utf8"), signal: AbortSignal.timeout(5000) });
  } else {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const week = process.argv.includes("--week") || command === "compare";
    if (week) from.setDate(from.getDate() - (from.getDay() + 6) % 7);
    const to = new Date(from); to.setDate(to.getDate() + (week ? 7 : 1));
    const query = new URLSearchParams({ from: value("--from") ?? from.toISOString(), to: value("--to") ?? to.toISOString() });
    for (const [flag, key] of [["--project", "projectId"], ["--language", "languageId"], ["--limit", "limit"], ["--after", "after"]]) {
      const supplied = value(flag!); if (supplied) query.set(key!, supplied);
    }
    const route = command === "telemetry" ? "query" : command;
    response = await fetch(`http://127.0.0.1:${config.port}/v2/${route}?${query}`, { headers, signal: AbortSignal.timeout(10_000) });
  }
  if (!response.ok) throw new Error(`Daemon returned ${response.status}: ${await response.text()}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} else if (command === "init") {
  const config = initializeConfig();
  console.log(`Initialized Stack Stats at ${configPath}`);
  console.log(`Daemon port: ${config.port}`);
} else if (["status", "summary", "pause", "resume"].includes(command)) {
  const config = loadConfig();
  const base = `http://127.0.0.1:${config.port}`;
  const headers = { authorization: `Bearer ${config.token}` };
  let response: Response;
  if (command === "status") response = await fetch(`${base}/health`);
  else if (command === "pause" || command === "resume") response = await fetch(`${base}/v1/${command}`, { method: "POST", headers });
  else {
    if (process.argv.includes("--legacy")) {
      const from = process.argv.includes("--today") ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString() : undefined;
      response = await fetch(`${base}/v1/summary${from ? `?from=${encodeURIComponent(from)}` : ""}`, { headers });
    } else {
      const period = process.argv.includes("--week") ? "week" : "today";
      response = await fetch(`${base}/v1/stats?period=${period}&date=${localDateKey(Date.now())}`, { headers });
    }
  }
  if (!response.ok) throw new Error(`Daemon returned ${response.status}: ${await response.text()}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} else {
  console.log("Usage: pnpm stackstats <init|status|summary [--today|--week] [--legacy]|pause|resume>");
  console.log("CLI pause/resume control daemon ingestion. Use VS Code's Pause Tracking to stop local collection.");
  console.log("Telemetry: telemetry|events|compare [--today|--week] [--from ISO --to ISO] [--project HASH] [--language ID]");
  console.log("Raw paging: events --limit 200 --after EVENT_UUID. Adapter ingestion: ingest --file BATCH.json");
}
