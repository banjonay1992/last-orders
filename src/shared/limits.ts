// Hard limits shared by the server, the clients and the quiz editor.
// Keeping them in one place means the editor can warn about exactly the
// same things the server will refuse.

export const LIMITS = {
  /** Largest quiz the server will accept, measured as JSON characters. */
  quizJsonChars: 100_000,
  /** Largest single WebSocket message the room will parse. */
  messageChars: 110_000,
  rounds: 12,
  questionsPerRound: 30,
  questionsTotal: 120,
  choiceOptionsMin: 2,
  choiceOptionsMax: 6,
  acceptedAnswersMax: 10,
  promptChars: 500,
  optionChars: 120,
  answerChars: 120,
  teamNameChars: 24,
  teamsPerRoom: 40,
  socketsPerRoom: 250,
  pointsMax: 10,
  timeLimitMinSeconds: 5,
  timeLimitMaxSeconds: 600,
  scoreAdjustMax: 50,
} as const;

/** A room is wiped this long after its last activity. */
export const ROOM_IDLE_TTL_MS = 12 * 60 * 60 * 1000;

/** Room codes use consonants only, which avoids accidental words and 0/O, 1/I mix-ups. */
export const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const ROOM_CODE_LENGTH = 4;

export function isRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of value) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function normaliseRoomCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z]/g, "");
}
