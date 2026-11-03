// Horaires des agents (champ schedule de agents.json), en UTC :
//   { type: "every", minutes }                     toutes les N minutes
//   { type: "daily", hourUTC, weekend, maxLateMin } une fois par jour, à cette heure (et n'importe quand le week-end si
//                                                  weekend : pour ne pas redémarrer un bot de trading en pleine séance) ;
//                                                  maxLateMin : en semaine, pas de départ plus de N min après l'heure
//                                                  (l'optimisation partie à 23 h 50 redémarrait le bot après la
//                                                  réouverture de l'or, remarque de l'agent patron du 01/11)
//   { type: "weekly", weekdayUTC, hourUTC }        une fois par semaine (0 = dimanche), à partir de cette heure
//   { type: "daily-activity", minTrades, maxDays } au plus une fois par jour, s'il y a eu assez d'activité (activity(),
//                                                  fournie par le projet), sinon au moins tous les maxDays jours
//   { type: "on-demand" }                          seulement à la demande (panel) ou déclenché par un autre agent
// Tous (sauf on-demand) : until (date ISO) = plus de passage automatique après cette date (campagne limitée).
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const day = (d) => d.toISOString().slice(0, 10);

// last : date ISO du dernier passage (ou null). activity(sinceMs) : nombre d'événements depuis (daily-activity).
const ended = (s, now) => !!(s.until && now.getTime() >= Date.parse(s.until));
function isDue(schedule, last, now = new Date(), activity = () => 0) {
  const s = schedule || {};
  if (ended(s, now)) return false;
  const lastMs = last ? Date.parse(last) : 0;
  const elapsed = now.getTime() - lastMs;
  switch (s.type) {
    case "every": return elapsed >= Math.max(1, Number(s.minutes) || 15) * 60e3 - 30e3;
    case "daily": {
      if (lastMs && day(new Date(lastMs)) === day(now)) return false;
      if (s.weekend && isWeekend(now)) return true;
      return now.getUTCHours() === Number(s.hourUTC) && (!s.maxLateMin || now.getUTCMinutes() <= Number(s.maxLateMin));
    }
    case "weekly": return now.getUTCDay() === Number(s.weekdayUTC) && now.getUTCHours() >= Number(s.hourUTC || 0) && elapsed > 6 * 86400e3;
    case "daily-activity":
      if (elapsed < 22 * 3600e3) return false;
      return elapsed > (Number(s.maxDays) || 7) * 86400e3 || activity(lastMs) >= (Number(s.minTrades) || 5);
    default: return false; // on-demand, inconnu
  }
}

// Prochain passage prévu (ISO), « à la demande », ou « dès que possible » ; pour l'affichage seulement.
function nextRun(schedule, last, now = new Date()) {
  const s = schedule || {};
  if (ended(s, now)) return "ended";
  const lastMs = last ? Date.parse(last) : 0;
  switch (s.type) {
    case "every": return new Date(Math.max(now.getTime(), lastMs + (Number(s.minutes) || 15) * 60e3)).toISOString();
    case "daily": {
      if (isDue(s, last, now)) return "soon";
      const t = new Date(now);
      if ((lastMs && day(new Date(lastMs)) === day(now)) || now.getUTCHours() > Number(s.hourUTC)) { t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(0, 0, 0, 0); }
      if (!(s.weekend && isWeekend(t))) t.setUTCHours(Number(s.hourUTC), 0, 0, 0);
      return t.toISOString();
    }
    case "weekly": {
      const t = new Date(Math.max(now.getTime(), lastMs + 6 * 86400e3));
      while (t.getUTCDay() !== Number(s.weekdayUTC)) t.setUTCDate(t.getUTCDate() + 1);
      if (t.getUTCHours() < Number(s.hourUTC || 0)) t.setUTCHours(Number(s.hourUTC || 0), 0, 0, 0);
      return t.toISOString();
    }
    case "daily-activity": return new Date(Math.max(now.getTime(), lastMs + 22 * 3600e3)).toISOString();
    default: return "on-demand";
  }
}

// Heure (et jour) UTC -> à Paris, à la date now (heure d'été ou d'hiver) : « 06 h UTC » ne parlait pas aux
// utilisateurs (parcours du 02/11). Affichage seulement : les horaires restent stockés en UTC.
const PARIS = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); // créé une fois : coûteux
function paris(hourUTC, now, weekdayUTC, minute = 0) {
  const d = new Date(now); d.setUTCHours(Number(hourUTC) || 0, Number(minute) || 0, 0, 0);
  if (weekdayUTC != null) d.setUTCDate(d.getUTCDate() + (Number(weekdayUTC) - d.getUTCDay() + 7) % 7);
  return Object.fromEntries(PARIS.formatToParts(d).map((x) => [x.type, x.value]));
}

// Description courte en français (panel), heures de Paris ; date de fin (until) ajoutée.
const PARIS_DAY = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", hourCycle: "h23" });
function label(schedule, now = new Date()) {
  const s = schedule || {};
  const base = baseLabel(s, now);
  if (!s.until || s.type === "on-demand") return base;
  const f = Object.fromEntries(PARIS_DAY.formatToParts(new Date(Date.parse(s.until))).map((x) => [x.type, x.value]));
  return ended(s, now) ? base + ", terminé le " + f.day + "/" + f.month : base + " jusqu'au " + f.day + "/" + f.month + " à " + f.hour + " h";
}
function baseLabel(s, now) {
  const h = (x, wd) => paris(x, now, wd).hour + " h (heure de Paris)";
  switch (s.type) {
    case "every": return "toutes les " + (Number(s.minutes) >= 60 && Number(s.minutes) % 60 === 0 ? Number(s.minutes) / 60 + " h" : (Number(s.minutes) || 15) + " min");
    case "daily": {
      const late = s.maxLateMin ? paris(s.hourUTC, now, null, s.maxLateMin) : null;
      return "chaque jour à " + h(s.hourUTC) + (late ? " (départ avant " + late.hour + ":" + late.minute + ")" : "") + (s.weekend ? " (ou le week-end)" : "");
    }
    case "weekly": return "chaque " + paris(s.hourUTC, now, Number(s.weekdayUTC) || 0).weekday + " à " + h(s.hourUTC, Number(s.weekdayUTC) || 0);
    case "daily-activity": return "chaque jour s'il y a eu " + (Number(s.minTrades) || 5) + " trades, sinon tous les " + (Number(s.maxDays) || 7) + " jours";
    default: return "à la demande";
  }
}

module.exports = { isDue, nextRun, label };
