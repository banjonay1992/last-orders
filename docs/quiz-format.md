# Quiz file format

A Last Orders quiz is a single JSON file. The schema lives in `src/shared/quiz.ts`, and both the server and the editor validate against it, so a file the editor accepts is a file the server accepts.

When a file is rejected, each problem is reported with its location, for example:

```
rounds[1].questions[0].answer: must be between 0 and 3
rounds[0].questions[2].media.url: must be an https:// URL or a path starting with /
```

Fields marked optional can be left out. Fields with a default are filled in when the file is loaded.

## Top level

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `format` | `"last-orders-quiz"` | yes | Identifies the file type. |
| `version` | `1` | yes | The format version. |
| `title` | text, 1 to 100 characters | yes | Shown on the big screen. |
| `rounds` | list of rounds, 1 to 12 | yes | Played in order. |
| `tiebreaker` | tie-breaker | optional | A numeric closest-guess question. |

A quiz may have at most 120 questions in total and must be no more than 100,000 characters of JSON.

## Round

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | text, 1 to 80 characters | yes | |
| `mode` | `"answers"` or `"buzzer"` | default `"answers"` | In `answers` rounds every team answers on its phone. In `buzzer` rounds teams race to buzz and answer out loud; the host marks each buzz. |
| `jokerAllowed` | true or false | default `true` | Whether teams may play their joker on this round. |
| `questions` | list of questions, 1 to 30 | yes | |

## Question

Every question has these fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | `"choice"` or `"text"` | yes | Multiple choice or free text. |
| `prompt` | text, 1 to 500 characters | yes | The question itself. |
| `points` | whole number, 1 to 10 | default `1` | Doubled for a team that played its joker on the round. |
| `timeLimitSeconds` | whole number, 5 to 600 | optional | Answers close automatically when time runs out. Without it, the host closes answers. |
| `media` | media | optional | A picture or an audio clip. |
| `hostNotes` | text, up to 500 characters | optional | Shown only on the host console. |

### Multiple choice (`"type": "choice"`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `options` | list of 2 to 6 texts, each up to 120 characters | yes | Shown as A, B, C and so on. Options must be different from each other (ignoring case). |
| `answer` | whole number | yes | The position of the right option, counting from 0. So `"answer": 1` means option B. |

Multiple-choice questions are marked automatically when answers lock.

### Free text (`"type": "text"`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `answers` | list of 1 to 10 texts, each up to 120 characters | yes | Accepted answers. The first is shown on the reveal. |

Answers that match one of these exactly, ignoring capitals, accents, punctuation, spaces between words and a leading "the", "a" or "an", are marked right automatically. Anything else is left for the host, with a hint when it is close (a small typo in a longer answer, or a surname on its own for a full name). Listing common alternatives, such as `["Pacific", "Pacific Ocean"]` or `["11", "eleven"]`, saves the host work.

## Media

A picture:

```json
{ "kind": "image", "url": "https://example.com/picture.jpg", "alt": "What the picture shows, for screen readers" }
```

The picture appears on the big screen and on phones once the question opens. `alt` is required.

An audio clip:

```json
{ "kind": "audio", "label": "Clip 3", "url": "/clips/clip-3.mp3" }
```

Audio is played by the host from the laptop, normally through the pub's speakers. The `label` is shown to everyone so teams know which clip is playing. The `url` is optional and is only ever sent to the host console. Leave it out and the host can pick a file from the laptop during the quiz instead; the file is played locally and never uploaded.

Media URLs must start with `https://` or be a path on the same site starting with `/` (for files you deploy in `public/`). Data URLs and plain `http://` links are refused.

## Tie-breaker

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `prompt` | text, 1 to 500 characters | yes | |
| `answer` | number | yes | The closest guess wins. On an exact tie, the earliest guess wins. |
| `unit` | text, up to 30 characters | optional | Shown next to the answer, for example `"days"`. |

## A minimal example

```json
{
  "format": "last-orders-quiz",
  "version": 1,
  "title": "Tuesday quiz",
  "rounds": [
    {
      "title": "General knowledge",
      "questions": [
        { "type": "choice", "prompt": "How many sides does a hexagon have?", "options": ["5", "6", "7", "8"], "answer": 1 },
        { "type": "text", "prompt": "What is the chemical symbol for gold?", "answers": ["Au"], "timeLimitSeconds": 30 }
      ]
    },
    {
      "title": "Fastest finger",
      "mode": "buzzer",
      "jokerAllowed": false,
      "questions": [{ "type": "text", "prompt": "Which is the largest ocean on Earth?", "answers": ["Pacific", "Pacific Ocean"], "points": 2 }]
    }
  ],
  "tiebreaker": { "prompt": "How many days are there in four years that include one leap year?", "answer": 1461, "unit": "days" }
}
```

A longer example with a picture round and a music round is in `quizzes/sample-quiz.json`.
