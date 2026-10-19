import { expect, test } from "bun:test";
import { exitCodeForResult } from "../src/exit-code";

test("bounded resource limits keep a partial result successful", () => {
  expect(
    exitCodeForResult({
      status: "incomplete",
      issues: [{ kind: "resource_limit", count: 4 }],
    }),
  ).toBe(0);
});

test("provider failures keep an incomplete result unsuccessful", () => {
  expect(
    exitCodeForResult({
      status: "incomplete",
      issues: [{ kind: "resource_limit", count: 1 }, { kind: "provider", count: 1 }],
    }),
  ).toBe(2);
});

test("interruption keeps its signal-friendly exit code", () => {
  expect(
    exitCodeForResult({
      status: "interrupted",
      issues: [{ kind: "interrupted", count: 1 }],
    }),
  ).toBe(130);
});
