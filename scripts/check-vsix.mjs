import { readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Release audit of a packaged VSIX: exact contents, manifest assets, README links and
// a scan for developer-machine paths and secrets. Reads the archive only; nothing is
// installed or published. `--release` additionally requires a real publisher.

/** Minimal reader for the stored/deflated ZIP archives that vsce writes. */
export function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a ZIP archive");
  const entries = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = buffer.readUInt16LE(end + 10); i > 0; i--) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    if (!name.endsWith("/")) entries.set(name, method === 0 ? raw : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`Unsupported compression in ${name}`); })());
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

// Personal or machine-specific locations and credential shapes. Runtime paths that the
// extension derives (homedir, globalStorage, process.execPath) never appear literally.
const forbidden = [
  ["home directory path", /\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][\w.-]*|[A-Za-z]:\\\\?Users\\\\?[\w.-]+/g],
  ["temporary directory path", /\/private\/(?:tmp|var)\/[\w.-]|\/var\/folders\/|\/tmp\/(?:claude|stack-stats)/g],
  ["hard-coded Node.js path", /\/usr\/local\/bin\/node|\/opt\/homebrew\/bin\/node|nvm\/versions\/node/g],
  ["file URL", /file:\/\/\/[A-Za-z]/g],
  ["email address", /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]{2,}/g],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["API token", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Supabase project or key", /[a-z0-9]{20}\.supabase\.co|\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}|service_role|SUPABASE_[A-Z_]+KEY/g],
  ["source map", /sourceMappingURL/g]
];

const png = (data) => data.length > 24 && data.readUInt32BE(0) === 0x89504e47 ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : undefined;

export async function checkVsix(file, { release = false } = {}) {
  const archive = await readFile(file);
  const entries = readZip(archive);
  const errors = [], warnings = [], notes = [];
  const text = (name) => entries.get(name)?.toString("utf8");
  const manifest = JSON.parse(text("extension/package.json") ?? "null");
  if (!manifest) throw new Error("extension/package.json is missing");
  const vsix = text("extension.vsixmanifest") ?? "";
  const identity = /<Identity [^>]*Id="([^"]+)"[^>]*Version="([^"]+)"[^>]*Publisher="([^"]+)"/.exec(vsix);
  const publisher = manifest.publisher ?? "undefined_publisher";
  const id = `${publisher}.${manifest.name}`;

  // Exactly the declared `files`, as vsce names them, plus the archive metadata.
  const packaged = (path) => `extension/${path === "README.md" ? "readme.md" : path === "LICENSE" ? "LICENSE.txt" : path}`;
  const expected = new Set(["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", ...(manifest.files ?? []).map(packaged)]);
  for (const name of entries.keys()) if (!expected.has(name)) errors.push(`Unexpected file in VSIX: ${name}`);
  for (const name of expected) if (!entries.has(name)) errors.push(`Missing from VSIX: ${name}`);

  // Every runtime path in the manifest must resolve inside the package.
  const inside = (path, what) => {
    if (typeof path !== "string" || !entries.has(`extension/${path.replace(/^\.\//, "")}`)) errors.push(`${what} does not resolve inside the VSIX: ${path}`);
  };
  inside(manifest.main, "main");
  inside(/node (\S+)/.exec(manifest.scripts?.["vscode:uninstall"] ?? "")?.[1], "vscode:uninstall script");
  inside(manifest.icon, "Marketplace icon");
  const icon = png(entries.get(`extension/${manifest.icon}`) ?? Buffer.alloc(0));
  if (!icon) errors.push("Marketplace icon must be a PNG");
  else if (icon.width !== icon.height || icon.width < 128) errors.push(`Marketplace icon must be square and at least 128×128 (is ${icon.width}×${icon.height})`);
  else if (icon.width < 256) warnings.push(`Marketplace icon is ${icon.width}×${icon.height}; 256×256 is recommended for high-DPI screens`);
  if (!/<Icon>extension\/[^<]+\.png<\/Icon>/.test(vsix)) errors.push("vsixmanifest has no PNG icon asset");
  for (const container of manifest.contributes?.viewsContainers?.activitybar ?? []) {
    inside(container.icon, `Activity Bar icon (${container.id})`);
    const svg = text(`extension/${container.icon}`) ?? "";
    if (!/viewBox="0 0 24 24"/.test(svg)) errors.push(`Activity Bar icon should be a 24×24 SVG: ${container.icon}`);
    if (/<script|<foreignObject|<image|href=|\son[a-z]+=|<style/i.test(svg)) errors.push(`Activity Bar icon must be a plain path-only SVG: ${container.icon}`);
  }
  if (!entries.has("extension/LICENSE.txt") || !/<License>/.test(vsix)) errors.push("License file is not packaged");
  for (const [field, value] of [["homepage", manifest.homepage], ["repository", manifest.repository?.url], ["bugs", manifest.bugs?.url]]) {
    if (!/^https:\/\//.test(value ?? "")) errors.push(`Manifest ${field} must be an https URL`);
  }
  if (!manifest.publisher) (release ? errors : warnings).push(`No "publisher": this build installs as ${id}. Set the confirmed publisher ID before the release build.`);

  // The Marketplace page renders the packaged README: absolute https links only.
  const readme = text("extension/readme.md") ?? "";
  for (const [, target] of readme.matchAll(/\]\(([^)\s]+)[^)]*\)/g)) {
    if (!/^https:\/\//.test(target)) errors.push(`README link is not absolute https: ${target}`);
    else if (/localhost|127\.0\.0\.1/.test(target)) errors.push(`README links to a local address: ${target}`);
  }
  for (const [, image] of readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) if (/\.svg(\?|$)/i.test(image)) errors.push(`README images may not be SVG: ${image}`);

  for (const [name, data] of entries) {
    if (png(data)) continue;
    const content = data.toString("utf8");
    for (const [label, pattern] of forbidden) {
      // Report where, never what: a match may be a live credential.
      const hits = [...content.matchAll(pattern)];
      if (hits.length) errors.push(`${name}: ${label} ×${hits.length}, first on line ${content.slice(0, hits[0].index).split("\n").length}`);
    }
    if (/^extension\/dist\//.test(name) && /127\.0\.0\.1|localhost/.test(content)) notes.push(`${name}: loopback references (optional local daemon; development-only auth origin)`);
  }

  const sizes = [...entries].map(([name, data]) => ({ name, bytes: data.length })).sort((a, b) => a.name.localeCompare(b.name));
  return { file: resolve(file), archiveBytes: (await stat(file)).size, files: sizes, id, version: manifest.version,
    vsixIdentity: identity ? { id: identity[1], version: identity[2], publisher: identity[3] } : undefined, icon, errors, warnings, notes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) { console.error("Usage: node scripts/check-vsix.mjs [--release] <file.vsix>"); process.exit(2); }
  const result = await checkVsix(file, { release: args.includes("--release") });
  console.log(`VSIX ${result.file}\n  extension ${result.id}@${result.version} (vsixmanifest publisher "${result.vsixIdentity?.publisher}")`);
  console.log(`  ${result.files.length} files, ${(result.archiveBytes / 1024).toFixed(2)} KB archive; icon ${result.icon ? `${result.icon.width}×${result.icon.height}` : "missing"}`);
  for (const { name, bytes } of result.files) console.log(`  ${String(bytes).padStart(8)}  ${name}`);
  for (const note of result.notes) console.log(`  note: ${note}`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  for (const error of result.errors) console.error(`  error: ${error}`);
  if (result.errors.length) { console.error(`VSIX check failed: ${result.errors.length} error(s).`); process.exit(1); }
  console.log("VSIX check passed.");
}
