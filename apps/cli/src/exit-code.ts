import type { Inventory, RetrievalResult } from "@repo/core";

type CliResult = Pick<Inventory | RetrievalResult, "status" | "issues">;

/** A bounded partial result is useful output, not a failed command. */
export function exitCodeForResult(result: CliResult): number {
  if (result.status === "interrupted") return 130;
  if (
    result.status === "incomplete" &&
    result.issues.some(({ kind }) => kind !== "resource_limit")
  )
    return 2;
  return 0;
}
