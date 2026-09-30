import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SYNC_LANGUAGES } from "@stack-stats/protocol";

const args = process.argv.slice(2);
const requireV2 = args.includes("--require-v2");
const paths = args.filter(argument => argument !== "--require-v2");
if (paths.length !== 1 || paths[0]!.startsWith("--") || args.filter(argument => argument === "--require-v2").length > 1) {
  throw new Error("Usage: node --import tsx scripts/check-sync-contract.mts [--require-v2] /path/to/stack-stats-web");
}
const web = paths[0]!;
const [source, vendored, sql] = await Promise.all([
  readFile(new URL("../packages/protocol/src/sync.ts", import.meta.url), "utf8"),
  readFile(resolve(web, "src/lib/sync-contract.ts"), "utf8"),
  readFile(resolve(web, "supabase/migrations/20260910000000_profile_sync.sql"), "utf8")
]);
if (source !== vendored) throw new Error("V1 sync contracts differ; preserve the existing contract and coordinate consumer changes.");
const languages = sql.match(/string_to_array\('([^']+)'/)?.[1]?.split(" ");
if (!languages || [...new Set(languages)].sort().join(" ") !== [...SYNC_LANGUAGES].sort().join(" ")) throw new Error("SQL language allowlist differs from the contract.");

if (requireV2) {
  // Vendor the versioned modules together so relative imports remain byte-identical.
  // Keep the existing sync-contract.ts consumer in place during the web migration.
  const [v2, bundledV1, bundledV2] = await Promise.all([
    readFile(new URL("../packages/protocol/src/sync-v2.ts", import.meta.url), "utf8"),
    readFile(resolve(web, "src/lib/stack-stats-protocol/sync.ts"), "utf8"),
    readFile(resolve(web, "src/lib/stack-stats-protocol/sync-v2.ts"), "utf8")
  ]);
  if (bundledV1 !== source || bundledV2 !== v2) throw new Error("V2 sync module bundle differs; vendor sync.ts and sync-v2.ts together without edits.");
  console.log("V1 contract and SQL language parity passed. V2 module source parity passed. Runtime server support and SQL v2 validation require their own tests.");
} else {
  console.log("V1 extension, web and SQL language contracts agree. V2 server support was not checked; use --require-v2 after the web migration.");
}
