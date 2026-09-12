import type { Job } from "../jobs";

export async function deliverJobResult(
  job: Job,
  result: { exitCode: number; stdout: string; stderr: string },
  send: {
    discord?: ((channel: string, text: string) => Promise<void>) | null;
    telegram?: ((chat: number, text: string, topic?: number) => Promise<void>) | null;
    defaults: () => void;
  }
): Promise<void> {
  if (!job.notifyChannel && job.notifyTelegramChat === undefined) {
    send.defaults();
    return;
  }
  const text =
    result.exitCode === 0
      ? `[${job.name}]\n${result.stdout || "(empty)"}`
      : `[${job.name}] error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
  const deliveries: Promise<void>[] = [];
  if (job.notifyChannel)
    deliveries.push(
      send.discord
        ? send.discord(job.notifyChannel, text)
        : Promise.reject(new Error("Discord notification target configured, but Discord is disabled"))
    );
  if (job.notifyTelegramChat !== undefined)
    deliveries.push(
      send.telegram
        ? send.telegram(job.notifyTelegramChat, text, job.notifyTelegramTopic)
        : Promise.reject(new Error("Telegram notification target configured, but Telegram is disabled"))
    );
  const results = await Promise.allSettled(deliveries);
  const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
}
