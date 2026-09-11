const defaults = ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.next/**", "**/.venv/**",
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/.ssh/**", "**/.aws/**", "**/secrets/**"];
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");

/** Small documented glob subset (*, **, ?) with no regex execution from settings.
 * Applied before hashing/collection, including sessions and all optional sources. */
export function compileGlob(pattern: string): RegExp {
  pattern = pattern.replaceAll("\\", "/");
  if (pattern.length > 512) throw new Error("Exclusion pattern is too long");
  let result = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { result += "(?:.*/)?"; i++; } else result += ".*";
    } else if (char === "*") result += "[^/]*";
    else if (char === "?") result += "[^/]";
    else result += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${result}$`, "i");
}

export class PrivacyPolicy {
  private readonly files: RegExp[];
  private readonly projects: RegExp[];
  constructor(excludeFiles: readonly string[] = [], excludeProjects: readonly string[] = []) {
    this.files = [...defaults, ...excludeFiles].map(compileGlob);
    this.projects = excludeProjects.map(compileGlob);
  }
  allowsProject(root: string): boolean {
    const path = normalize(root);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (this.projects.some((pattern) => pattern.test(ancestor) || pattern.test(`${ancestor}/`) || pattern.test(parts[i - 1]!))) return false;
    }
    return true;
  }
  allows(root: string | undefined, path: string): boolean {
    if (root && !this.allowsProject(root)) return false;
    const absolute = normalize(path);
    const parent = absolute.slice(0, absolute.lastIndexOf("/"));
    if (parent && !this.allowsProject(parent)) return false;
    const relative = root && absolute.startsWith(`${normalize(root)}/`) ? absolute.slice(normalize(root).length + 1) : absolute;
    return !this.files.some((pattern) => pattern.test(relative) || pattern.test(absolute) || pattern.test(`${relative}/`));
  }
}
