// Generates the tiny audio clips used by the sample quiz's music round.
// They are simple synthesised tones, so there is nothing to license.
// Run with: node scripts/make-sample-audio.mjs
import { writeFileSync } from "node:fs";

const RATE = 8000;

function wav(samples) {
  const data = Buffer.alloc(samples.length);
  samples.forEach((s, i) => (data[i] = Math.max(0, Math.min(255, Math.round(128 + s * 100)))));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function tone(freq, seconds) {
  const n = Math.round(RATE * seconds);
  const fade = Math.round(RATE * 0.01);
  return Array.from({ length: n }, (_, i) => {
    const env = Math.min(1, i / fade, (n - i) / fade);
    return Math.sin((2 * Math.PI * freq * i) / RATE) * env;
  });
}

const silence = (seconds) => new Array(Math.round(RATE * seconds)).fill(0);

const out = new URL("../public/sample-media/", import.meta.url);
const beeps = [];
for (let i = 0; i < 5; i++) beeps.push(...tone(660, 0.18), ...silence(0.32));
writeFileSync(new URL("beeps.wav", out), wav(beeps));
writeFileSync(new URL("two-notes.wav", out), wav([...tone(392, 0.8), ...silence(0.3), ...tone(523.25, 0.8)]));
writeFileSync(new URL("tuning-note.wav", out), wav(tone(440, 2)));
console.log("Wrote sample audio to public/sample-media/");
