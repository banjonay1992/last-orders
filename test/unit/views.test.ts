import { describe, expect, it } from "vitest";
import { hostView, screenView, teamView } from "../../src/worker/views";
import { Game, team } from "./helpers";

describe("role views", () => {
  function game() {
    const g = new Game().loaded();
    const [a, b] = [g.join("Alpha"), g.join("Bravo")];
    return { g, a, b };
  }

  it("hides the prompt from phones and the screen until the question opens", () => {
    const { g, a } = game();
    g.show(0, 1);
    expect(screenView(g.state, new Set()).question?.prompt).toBe("");
    expect(teamView(g.state, new Set(), a)?.question?.prompt).toBe("");
    expect(hostView(g.state, new Set()).question?.prompt).toBe("Capital of France?");
    g.host({ type: "host.open" });
    expect(screenView(g.state, new Set()).question?.prompt).toBe("Capital of France?");
  });

  it("never sends the correct answer or other teams' answers to a phone before the reveal", () => {
    const { g, a, b } = game();
    g.show(0, 1).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.1", value: "Paris" });
    g.as(team(b), { type: "team.answer", questionKey: "0.1", value: "Rome" });
    g.host({ type: "host.lock" });
    const json = JSON.stringify(teamView(g.state, new Set(), b));
    expect(json).not.toContain("Paris");
    expect(json).not.toContain("host-token");
    expect(json).not.toContain("token-");
    expect(teamView(g.state, new Set(), b)?.myAnswer).toMatchObject({ value: "Rome", verdict: null });
    const screen = JSON.stringify(screenView(g.state, new Set()));
    expect(screen).not.toContain("Paris");
    expect(screen).not.toContain("Rome");
    g.host({ type: "host.reveal" });
    const after = teamView(g.state, new Set(), a)!;
    expect(after.question?.reveal?.text).toBe("Paris");
    expect(after.myAnswer?.verdict).toBe(true);
  });

  it("keeps audio URLs on the host", () => {
    const g = new Game();
    g.host({
      type: "host.loadQuiz",
      quiz: {
        format: "last-orders-quiz",
        version: 1,
        title: "Music",
        rounds: [
          {
            title: "Music",
            questions: [{ type: "text", prompt: "Name it", answers: ["A"], media: { kind: "audio", label: "Clip 1", url: "https://example.com/c.mp3" } }],
          },
        ],
      },
    });
    const a = g.join("A");
    g.show(0, 0).host({ type: "host.open" });
    expect(JSON.stringify(teamView(g.state, new Set(), a))).not.toContain("example.com");
    expect(JSON.stringify(screenView(g.state, new Set()))).not.toContain("example.com");
    expect(teamView(g.state, new Set(), a)?.question?.media).toEqual({ kind: "audio", label: "Clip 1" });
    expect(JSON.stringify(hostView(g.state, new Set()))).toContain("example.com");
  });

  it("gives the host marking suggestions and connection status", () => {
    const { g, a, b } = game();
    g.show(0, 1).host({ type: "host.open" });
    g.as(team(a), { type: "team.answer", questionKey: "0.1", value: "Pariss" });
    g.host({ type: "host.lock" });
    const view = hostView(g.state, new Set([a]));
    const rows = view.detail!.answers;
    expect(rows.find((r) => r.teamId === a)).toMatchObject({ suggestion: "close", closestTo: "Paris", verdict: null });
    expect(rows.find((r) => r.teamId === b)).toMatchObject({ value: null });
    expect(view.detail!.unmarked).toBe(1);
    expect(view.teams.find((t) => t.id === a)?.connected).toBe(true);
    expect(view.teams.find((t) => t.id === b)?.connected).toBe(false);
  });

  it("offers jokers only on rounds that allow them and have not started", () => {
    const { g, a } = game();
    expect(teamView(g.state, new Set(), a)?.jokerRounds).toEqual([0, 2]);
    g.show(0, 0).host({ type: "host.open" });
    expect(teamView(g.state, new Set(), a)?.jokerRounds).toEqual([2]);
    g.as(team(a), { type: "team.joker", round: 2 });
    expect(teamView(g.state, new Set(), a)?.jokerRounds).toEqual([]);
  });

  it("returns null for a team that is not in the room", () => {
    const { g } = game();
    expect(teamView(g.state, new Set(), "ghost")).toBeNull();
  });
});
