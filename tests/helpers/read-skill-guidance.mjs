import { readFile as originalReadFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Existing prose-contract tests cover the maintained guidance, wherever it is
// packaged. Follow only linked Markdown within this skill; a broken reference
// fails the tests instead of silently omitting that mode's instructions.
export function readSkillGuidanceSync(file) {
  const entry = file instanceof URL ? fileURLToPath(file) : file;
  const root = path.dirname(entry);
  const visited = new Set();
  function visit(current) {
    if (visited.has(current)) return "";
    if (path.relative(root, current).startsWith("..")) {
      throw new Error(`Skill reference escapes its package: ${current}`);
    }
    visited.add(current);
    const text = readFileSync(current, "utf8");
    const linked = [...text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
      .map((match) => match[1])
      .filter((target) => !target.includes(":") && !path.isAbsolute(target))
      .map((target) => visit(path.resolve(path.dirname(current), target)));
    return [text, ...linked].join("\n");
  }
  return visit(path.resolve(entry));
}

export async function readFileWithSkillReferences(file, options) {
  const pathname = file instanceof URL ? fileURLToPath(file) : String(file);
  if (pathname.endsWith("/recall-journal/SKILL.md") && options === "utf8") {
    return readSkillGuidanceSync(file);
  }
  return originalReadFile(file, options);
}

/** Read the selected table route only; other modes cannot satisfy its contract. */
export function readModeGuidanceSync(file, label, entryOverride) {
  const entry = file instanceof URL ? fileURLToPath(file) : file;
  const text = entryOverride ?? readFileSync(entry, "utf8");
  const rows = text.split("\n").filter((line) => line.startsWith("|"));
  const row = rows.find((line) => line.split("|")[1].trim() === label);
  if (!row) throw new Error(`Missing journal mode route: ${label}`);
  const direct = [...row.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]);
  if (!direct.length) throw new Error(`Empty journal mode route: ${label}`);
  const shared = text.split("\n").filter((line) => !line.startsWith("|")).join("\n");
  const root = path.dirname(entry);
  const bundles = direct.map((target) => {
    if (target.includes(":") || path.isAbsolute(target) || path.relative(root, path.resolve(root, target)).startsWith("..")) {
      throw new Error(`Mode reference escapes its package: ${target}`);
    }
    return readSkillGuidanceSync(path.resolve(root, target));
  });
  return { direct, text: [shared, ...bundles].join("\n") };
}
