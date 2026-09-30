const basename = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const extname = (name: string) => { const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot) : ""; };

// VS Code language IDs for files Stack Stats sees only on disk (no open document).
// Inferred from the file name; anything unlisted stays "unknown" rather than guessed.
const byExtension: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascriptreact", py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", dart: "dart",
  cs: "csharp", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", c: "c", h: "c", m: "objective-c", mm: "objective-cpp",
  rb: "ruby", php: "php", scala: "scala", lua: "lua", r: "r", jl: "julia", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell",
  clj: "clojure", fs: "fsharp", vue: "vue", svelte: "svelte", html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", md: "markdown", mdx: "mdx", sql: "sql",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", ps1: "powershell", graphql: "graphql", gql: "graphql", proto: "proto3",
  tf: "terraform", ini: "ini", txt: "plaintext", ipynb: "jupyter"
};
const byName: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby" };

export function languageFromPath(path: string): string {
  const name = basename(path).toLowerCase();
  return byName[name] ?? byExtension[extname(name).slice(1)] ?? "unknown";
}

const binary = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "psd", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "jar", "war", "class", "pyc", "pyo", "o", "a", "so", "dylib", "dll", "exe", "bin", "wasm", "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "avi", "wav", "flac", "ogg", "webm", "sqlite", "db", "node"]);
/** Common binary artifacts carry no line semantics; they are counted, not tracked. */
export const isBinaryPath = (path: string) => binary.has(extname(basename(path)).slice(1).toLowerCase());

/** Editor/agent scratch files that exist only to make a write atomic or to lock a
 * buffer. Claude Code was observed writing `<file>.tmp.<pid>.<hex>` then renaming. */
export function isTransientArtifact(path: string): boolean {
  const name = basename(path);
  return /\.tmp\.\d+\.[0-9a-f]{6,}$/i.test(name) || /\.tmp$/i.test(name) || /~$/.test(name) || /^\.#/.test(name) || /^#.*#$/.test(name)
    || /\.sw[a-p]$/i.test(name) || name === "4913" || /\.crswap$/i.test(name);
}
