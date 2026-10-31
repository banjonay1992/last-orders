// Marking helpers for free-text answers. These only ever produce a
// suggestion for the quizmaster; a person always makes the final call on
// anything that is not an exact match.

const LEADING_ARTICLES = /^(the|a|an)\s+/;

/**
 * Lower-cases, strips accents and punctuation, turns "&" into "and",
 * drops a leading "the", "a" or "an" and collapses whitespace.
 * "  The Beatles! " and "beatles" both become "beatles".
 */
export function normaliseAnswer(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(LEADING_ARTICLES, "")
    .replace(/\s+/g, " ");
}

/** Classic edit distance with a single rolling row. Inputs are short (120 chars max). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

export type MatchKind = "exact" | "close" | "none";

export interface Suggestion {
  kind: MatchKind;
  /** The accepted answer the submission is closest to. */
  closestTo: string | null;
}

/**
 * How many typos to forgive for an answer of a given length. Short answers
 * get no slack ("cat" vs "car" are different answers); longer ones get a
 * little more, so "Shakespere" still lands near "Shakespeare".
 */
function allowedSlips(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  if (length <= 12) return 2;
  return 3;
}

export function suggestMark(submitted: string, accepted: readonly string[]): Suggestion {
  const s = normaliseAnswer(submitted);
  if (!s) return { kind: "none", closestTo: null };
  let best: { answer: string; distance: number; slips: number } | null = null;
  for (const answer of accepted) {
    const a = normaliseAnswer(answer);
    if (!a) continue;
    if (a === s) return { kind: "exact", closestTo: answer };
    // Compare without spaces as well, so "new castle" matches "newcastle".
    if (a.replace(/ /g, "") === s.replace(/ /g, "")) return { kind: "exact", closestTo: answer };
    const distance = editDistance(a, s);
    const slips = allowedSlips(a.length);
    if (!best || distance < best.distance) best = { answer, distance, slips };
    // Surname-only answers are common ("Austen" for "Jane Austen").
    const words = a.split(" ");
    if (words.length > 1 && words[words.length - 1] === s && s.length >= 4) {
      return { kind: "close", closestTo: answer };
    }
  }
  if (best && best.distance <= best.slips) return { kind: "close", closestTo: best.answer };
  return { kind: "none", closestTo: best?.answer ?? null };
}
