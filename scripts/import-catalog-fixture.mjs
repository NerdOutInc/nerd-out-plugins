#!/usr/bin/env node
// Imports a Recall app tool-catalog dump into the checked-in fixture that the
// byte-budget test and scripts/measure-context-cost.mjs read. Only what an
// agent receives survives (name, description, inputSchema), so shell-only
// fields such as webMethod or requiredScopes never move the byte counts, and
// the fixture cannot drift from a hand edit. Produce the dump in the app
// repository at the commit being measured:
//   node scripts/check-mcp-tool-catalog-parity.mjs --dump-swift > catalog.json
// then run  node scripts/import-catalog-fixture.mjs catalog.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [source] = process.argv.slice(2);
if (!source) {
  process.stderr.write("usage: import-catalog-fixture.mjs <catalog-dump.json>\n");
  process.exit(2);
}

const dump = JSON.parse(fs.readFileSync(source, "utf8"));
const tools = (dump.tools ?? []).map((tool) => ({
  description: tool.description ?? "",
  inputSchema: tool.inputSchema ?? {},
  name: tool.name,
}));
if (!Number.isInteger(dump.catalogVersion) || tools.length === 0) {
  throw new Error("the dump needs an integer catalogVersion and a non-empty tools array");
}

const target = path.join(repositoryRoot, "tests/fixtures/recall-catalog", `generation-${dump.catalogVersion}.json`);
fs.writeFileSync(target, `${JSON.stringify({ catalogVersion: dump.catalogVersion, tools }, null, 2)}\n`);
const size = tools.reduce((total, tool) => total + Buffer.byteLength(tool.description) + Buffer.byteLength(JSON.stringify(tool.inputSchema)), 0);
process.stdout.write(`${path.relative(repositoryRoot, target)}: ${tools.length} tools, ${size} bytes of descriptions and schemas\n`);
