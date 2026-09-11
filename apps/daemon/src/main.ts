import { createServer } from "./server.js";
import { loadConfig } from "../../cli/src/config.js";

const config = loadConfig();
const app = createServer({ databasePath: config.databasePath, token: config.token, logger: process.env.STACK_STATS_LOG !== "off", allowAttributionReports: process.env.STACK_STATS_ALLOW_ATTRIBUTION === "1" });
await app.listen({ host: "127.0.0.1", port: config.port });
console.log(`Stack Stats daemon listening at http://127.0.0.1:${config.port}`);
console.log(`Writing events to ${config.databasePath}`);
console.log("Request logging is on; set STACK_STATS_LOG=off to silence it.");
