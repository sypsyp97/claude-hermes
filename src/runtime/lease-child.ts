// A leased task cannot start Claude until its process group is recorded in SQLite.
// EOF without permission means the owner died before completing registration.
if ((await Bun.stdin.text()) !== "run\n") process.exit(125);

const child = Bun.spawn(process.argv.slice(2), {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
  windowsHide: true,
});
process.exit(await child.exited);

export {};
