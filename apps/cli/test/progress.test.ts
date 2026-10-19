import { expect, test } from "bun:test";
import { createProgress } from "../src/progress";

test("disabled progress emits no terminal bytes", () => {
  const output: string[] = [];
  const progress = createProgress({ enabled: false, write: (text) => output.push(text) });

  progress.start();
  progress.update({ files: 3, bytes: 2048 });
  progress.done();

  expect(output).toEqual([]);
});

test("interactive progress keeps one live row with file and byte counts", async () => {
  const output: string[] = [];
  const progress = createProgress({ enabled: true, write: (text) => output.push(text) });

  progress.start();
  await new Promise((resolve) => setTimeout(resolve, 110));
  progress.update({ files: 3, bytes: 2048 });
  progress.done();

  expect(output.join("")).toContain("Searching — 3 files · 2.0 KiB");
  expect(output.at(-1)).toBe("\r\u001b[2K");
});
