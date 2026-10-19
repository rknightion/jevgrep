import type { ProgressSnapshot } from "@repo/core";

type ProgressOptions = {
  enabled: boolean;
  write: (text: string) => void;
};

const frames = ["-", "\\", "|", "/"];

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (unit < units.length - 1 && value >= 1024) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function createProgress(options: ProgressOptions) {
  let active = false;
  let frame = 0;
  let snapshot: ProgressSnapshot = { files: 0, bytes: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastRenderedAt = 0;

  const render = (force = false) => {
    if (!active) return;
    const now = Date.now();
    if (!force && now - lastRenderedAt < 100) return;
    lastRenderedAt = now;
    options.write(
      `\r\u001b[2K${frames[frame]} Searching — ${snapshot.files} ${snapshot.files === 1 ? "file" : "files"} · ${size(snapshot.bytes)}`,
    );
  };

  return {
    start() {
      if (!options.enabled || active) return;
      active = true;
      render(true);
      timer = setInterval(() => {
        frame = (frame + 1) % frames.length;
        render(true);
      }, 120);
      timer.unref?.();
    },
    update(next: ProgressSnapshot) {
      if (!options.enabled) return;
      snapshot = next;
      render();
    },
    done() {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      options.write("\r\u001b[2K");
    },
  };
}
