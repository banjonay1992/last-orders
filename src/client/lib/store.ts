// Small wrappers around localStorage. The only things kept are random
// tokens that let a device rejoin its room, and quiz drafts from the
// editor. No names, no tracking. Every access is guarded because private
// browsing modes can throw.

import type { QuizInput } from "../../shared/quiz";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage full or disabled. The app still works; it just cannot resume.
  }
}

export const hostToken = {
  get: (code: string) => read(`lastorders.host.${code}`),
  set: (code: string, token: string | null) => write(`lastorders.host.${code}`, token),
};

export const teamToken = {
  get: (code: string) => read(`lastorders.team.${code}`),
  set: (code: string, token: string | null) => write(`lastorders.team.${code}`, token),
};

export interface Draft {
  id: string;
  savedAt: number;
  quiz: QuizInput;
}

const DRAFTS_KEY = "lastorders.drafts";

export function listDrafts(): Draft[] {
  try {
    const parsed = JSON.parse(read(DRAFTS_KEY) ?? "[]") as Draft[];
    return Array.isArray(parsed) ? parsed.sort((a, b) => b.savedAt - a.savedAt) : [];
  } catch {
    return [];
  }
}

export function saveDraft(draft: Draft): void {
  const others = listDrafts().filter((d) => d.id !== draft.id);
  write(DRAFTS_KEY, JSON.stringify([draft, ...others].slice(0, 30)));
}

export function deleteDraft(id: string): void {
  write(DRAFTS_KEY, JSON.stringify(listDrafts().filter((d) => d.id !== id)));
}

export function newDraftId(): string {
  return Math.random().toString(36).slice(2, 10);
}
