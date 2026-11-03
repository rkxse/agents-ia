// Horaires des agents (lib/schedule.js). Lancer : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { isDue, nextRun, label } = require("../lib/schedule");

const at = (iso) => new Date(iso);

test("toutes les N minutes", () => {
  const s = { type: "every", minutes: 15 };
  assert.equal(isDue(s, null, at("2026-11-02T10:00:00Z")), true, "jamais passé : tout de suite");
  assert.equal(isDue(s, "2026-11-02T09:50:00Z", at("2026-11-02T10:00:00Z")), false);
  assert.equal(isDue(s, "2026-11-02T09:45:10Z", at("2026-11-02T10:00:00Z")), true, "30 s de marge (passage chaque minute)");
});

test("chaque jour à 21 h UTC, ou n'importe quand le week-end", () => {
  const s = { type: "daily", hourUTC: 21, weekend: true };
  assert.equal(isDue(s, "2026-11-02T21:05:00Z", at("2026-11-03T20:30:00Z")), false, "mardi 20 h 30 : pas encore");
  assert.equal(isDue(s, "2026-11-02T21:05:00Z", at("2026-11-03T21:01:00Z")), true, "mardi 21 h");
  assert.equal(isDue(s, "2026-11-03T21:01:00Z", at("2026-11-03T21:40:00Z")), false, "déjà passé aujourd'hui");
  assert.equal(isDue(s, "2026-11-06T21:01:00Z", at("2026-11-07T09:00:00Z")), true, "samedi matin");
  assert.equal(isDue({ ...s, weekend: false }, "2026-11-06T21:01:00Z", at("2026-11-07T09:00:00Z")), false);
});

test("pas de départ trop tard en semaine (maxLateMin)", () => {
  const s = { type: "daily", hourUTC: 22, weekend: true, maxLateMin: 30 };
  assert.equal(isDue(s, "2026-11-02T22:05:00Z", at("2026-11-03T22:20:00Z")), true, "mardi 22 h 20");
  assert.equal(isDue(s, "2026-11-02T22:05:00Z", at("2026-11-03T22:50:00Z")), false, "mardi 22 h 50 : trop tard, demain");
  assert.equal(isDue(s, "2026-11-06T22:05:00Z", at("2026-11-07T23:50:00Z")), true, "le week-end, n'importe quand");
  assert.equal(label(s, at("2026-11-03T12:00:00Z")), "chaque jour à 23 h (heure de Paris) (départ avant 23:30) (ou le week-end)", "l'hiver : UTC+1");
  assert.equal(label(s, at("2026-07-03T12:00:00Z")), "chaque jour à 00 h (heure de Paris) (départ avant 00:30) (ou le week-end)", "l'été : UTC+2");
});

test("chaque semaine, selon l'activité, à la demande", () => {
  const w = { type: "weekly", weekdayUTC: 0, hourUTC: 10 };
  assert.equal(isDue(w, "2026-11-01T10:05:00Z", at("2026-11-08T10:01:00Z")), true, "dimanche suivant");
  assert.equal(isDue(w, "2026-11-01T10:05:00Z", at("2026-11-07T10:01:00Z")), false, "samedi");
  const d = { type: "daily-activity", minTrades: 5, maxDays: 7 };
  assert.equal(isDue(d, "2026-11-02T08:00:00Z", at("2026-11-03T09:00:00Z"), () => 3), false, "3 trades seulement");
  assert.equal(isDue(d, "2026-11-02T08:00:00Z", at("2026-11-03T09:00:00Z"), () => 6), true);
  assert.equal(isDue(d, "2026-11-02T08:00:00Z", at("2026-11-02T20:00:00Z"), () => 50), false, "moins de 22 h");
  assert.equal(isDue(d, "2026-10-20T08:00:00Z", at("2026-11-02T09:00:00Z"), () => 0), true, "plus de 7 jours");
  assert.equal(isDue({ type: "on-demand" }, null, at("2026-11-02T09:00:00Z")), false);
});

test("date de fin (until) : plus de passage automatique ensuite", () => {
  const s = { type: "every", minutes: 240, until: "2026-11-09T01:00:00.000Z" };
  assert.equal(isDue(s, "2026-11-08T20:00:00Z", at("2026-11-09T00:30:00Z")), true, "avant la fin");
  assert.equal(isDue(s, "2026-11-08T20:00:00Z", at("2026-11-09T01:30:00Z")), false, "après la fin");
  assert.equal(nextRun(s, "2026-11-08T20:00:00Z", at("2026-11-09T01:30:00Z")), "ended");
  assert.equal(label(s, at("2026-11-03T12:00:00Z")), "toutes les 4 h jusqu'au 09/11 à 02 h");
  assert.equal(label(s, at("2026-11-10T12:00:00Z")), "toutes les 4 h, terminé le 09/11");
  const { cleanSchedule } = require("../lib/agents-admin");
  assert.equal(cleanSchedule(s).until, "2026-11-09T01:00:00.000Z");
  assert.equal(cleanSchedule({ ...s, until: "n'importe quoi" }).until, undefined);
});

test("prochain passage et libellé", () => {
  assert.equal(nextRun({ type: "daily", hourUTC: 21, weekend: true }, "2026-11-03T21:01:00Z", at("2026-11-03T21:40:00Z")), "2026-11-04T21:00:00.000Z");
  assert.equal(nextRun({ type: "daily", hourUTC: 21, weekend: true }, "2026-11-06T21:01:00Z", at("2026-11-06T22:00:00Z")), "2026-11-07T00:00:00.000Z", "veille de week-end");
  assert.equal(nextRun({ type: "on-demand" }, null), "on-demand");
  assert.equal(label({ type: "every", minutes: 60 }), "toutes les 1 h");
  assert.equal(label({ type: "every", minutes: 15 }), "toutes les 15 min");
  assert.equal(label({ type: "weekly", weekdayUTC: 1, hourUTC: 6 }, at("2026-11-03T12:00:00Z")), "chaque lundi à 07 h (heure de Paris)");
  assert.equal(label({ type: "weekly", weekdayUTC: 0, hourUTC: 23 }, at("2026-11-03T12:00:00Z")), "chaque lundi à 00 h (heure de Paris)", "le jour suit quand l'heure passe minuit");
});
