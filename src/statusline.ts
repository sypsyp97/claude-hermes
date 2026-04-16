import { join } from "path";
import { hermesDir } from "./paths";

// Write state.json so the statusline script can read fresh data
export interface StateData {
  heartbeat?: { nextAt: number };
  jobs: { name: string; nextAt: number }[];
  security: string;
  telegram: boolean;
  discord: boolean;
  startedAt: number;
}

export async function writeState(state: StateData) {
  await Bun.write(
    join(hermesDir(), "state.json"),
    JSON.stringify(state) + "\n"
  );
}
