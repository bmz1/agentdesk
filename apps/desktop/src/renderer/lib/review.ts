import type { ReviewComment } from "./store"

/** Keep original side, line and source text: edits may shift the current diff. */
export const reviewPrompt = (comments: ReadonlyArray<ReviewComment>) =>
  [
    "Please address the following review feedback. Locations refer to the diff when each comment was written; use the quoted code to locate it if lines have moved.",
    ...comments
      .filter((c) => !c.resolved)
      .map((c, i) => `${i + 1}. ${c.path} (${c.side} line ${c.line})\nCode: ${JSON.stringify(c.code)}\nFeedback: ${c.text}`)
  ].join("\n\n")
