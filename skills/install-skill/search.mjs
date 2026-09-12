// Search the structured skills.sh API. Usage: node search.mjs <query>
const query = process.argv[2];
if (!query) {
  console.log(JSON.stringify({ error: "No search query provided" }));
  process.exit(1);
}
try {
  const response = await fetch(`https://www.skills.sh/api/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`skills.sh API returned HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.skills)) throw new Error("Invalid skills.sh search response");
  const skills = data.skills.filter(s => typeof s.source === "string" && typeof s.skillId === "string" && typeof s.name === "string").map(s => ({
    source: s.source, id: s.skillId, name: s.name,
    installs: typeof s.installs === "number" && Number.isFinite(s.installs) ? s.installs : 0,
  }));
  skills.sort((a, b) => b.installs - a.installs);
  console.log(JSON.stringify(skills.slice(0, 15), null, 2));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exit(1);
}
