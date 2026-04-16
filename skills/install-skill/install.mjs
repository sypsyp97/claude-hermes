// Download a skill from GitHub into the project's skills/ directory
// Usage: node install.mjs <owner/repo> <skill-name> [target-dir]
// Works with Node 18+, Bun, Deno

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const repo = process.argv[2];
const skillName = process.argv[3];
const targetDir = process.argv[4] || join(process.cwd(), "skills");

if (!repo || !skillName) {
  console.log(JSON.stringify({ error: "Usage: node install.mjs <owner/repo> <skill-name> [target-dir]" }));
  process.exit(1);
}

try {
  // List files in the skill directory via GitHub API
  const apiUrl = `https://api.github.com/repos/${repo}/contents/skills/${skillName}`;
  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "claude-hermes-skill-installer" },
  });

  if (!res.ok) {
    // Try root-level skill (some repos put SKILL.md at root)
    const rootRes = await fetch(`https://api.github.com/repos/${repo}/contents/${skillName}`, {
      headers: { "User-Agent": "claude-hermes-skill-installer" },
    });
    if (!rootRes.ok) {
      console.log(JSON.stringify({ error: `Skill not found at skills/${skillName} or ${skillName} in ${repo}` }));
      process.exit(1);
    }
    var files = await rootRes.json();
  } else {
    var files = await res.json();
  }

  if (!Array.isArray(files)) files = [files];

  const destDir = join(targetDir, skillName);
  mkdirSync(destDir, { recursive: true });

  const downloaded = [];
  for (const file of files) {
    if (file.type !== "file") continue;
    const raw = await fetch(file.download_url);
    const content = await raw.text();
    const filePath = join(destDir, file.name);
    writeFileSync(filePath, content);
    downloaded.push(file.name);
  }

  console.log(JSON.stringify({
    ok: true,
    skill: skillName,
    source: repo,
    path: destDir,
    files: downloaded,
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
