// Stint-Planer für Langstrecken: Plan normalisieren, Stints berechnen und mit der laufenden Session abgleichen.
// Gemeinsam für Core (Einstellungen prüfen), Hauptfenster (Planer) und Overlay «Stint-Plan» (auch im PIT Monitor).
//
// Plan (in den Einstellungen unter stintPlans.<id>):
//   name, mode: 'time' | 'laps', hours, minutes, laps, startTime ('HH:MM', Ortszeit, leer = keine Uhrzeit)
//   lapTime (s), fuelPerLap (l), tank (l), reserve (Runden Reserve im Tank)
//   pitLane (s, Zeitverlust Durchfahrt Boxengasse), fuelRate (l/s), tireTime (s), tiresEvery (alle n Stopps, 0 = nie)
//   maxDrive (min, längster Stint am Stück, 0 = so lange der Tank reicht), perTurn (Stints am Stück je Fahrer)
//   drivers: [{ id, name, color }]
//   stints: [{ d, laps, tires }] – eigene Anpassungen je geplantem Stint (null = automatisch)
//   events: [{ id, lap, kind, repair, penalty, lane, refuel, tires, change, note }] – Unvorhergesehenes im Rennen:
//     kind 'pit' = Reparatur in der Box, 'tow' = Abschleppen (penalty = Abschleppzeit/Zeitstrafe), 'penalty' = Strafe
//     (lane = durch die Boxengasse, z. B. Drive-through), 'loss' = sonstiger Zeitverlust (Dreher, Unfall …).
//     Bei 'pit'/'tow' mit refuel endet der Stint dort: volltanken, danach fährt derselbe (change 'same') oder der nächste
//     Fahrer ('next') weiter, und alle folgenden Stints verschieben sich.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OMStint = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const COLORS = ['#EBB626', '#2FB5D6', '#FF5F52', '#45D27A', '#B48CFF', '#FF8A1F', '#E9E7E1', '#FF5888'];
  const MAX_STINTS = 200;
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const HEX = /^#[0-9a-f]{6}$/i;

  function newPlan(name) {
    return {
      name: name || 'Langstrecke', mode: 'time', hours: 6, minutes: 0, laps: 200, startTime: '',
      lapTime: 90, fuelPerLap: 3, tank: 100, reserve: 0.5,
      pitLane: 25, fuelRate: 2.5, tireTime: 20, tiresEvery: 2,
      maxDrive: 0, perTurn: 1, balance: true,
      drivers: [{ id: 'd1', name: '', color: COLORS[0] }, { id: 'd2', name: '', color: COLORS[1] }],
      stints: [],
      events: [],
    };
  }
  const KINDS = { pit: 'Reparatur in der Box', tow: 'Abschleppen', penalty: 'Strafe', loss: 'Zeitverlust' };

  function normalize(p) {
    const s = p && typeof p === 'object' ? p : {};
    const d = newPlan();
    const out = {
      name: String(s.name ?? d.name).slice(0, 60) || d.name,
      mode: s.mode === 'laps' ? 'laps' : 'time',
      hours: Math.round(num(s.hours, d.hours, 0, 48)),
      minutes: Math.round(num(s.minutes, d.minutes, 0, 59)),
      laps: Math.round(num(s.laps, d.laps, 1, 5000)),
      startTime: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s.startTime || '')) ? String(s.startTime) : '',
      lapTime: num(s.lapTime, d.lapTime, 20, 1200),
      fuelPerLap: num(s.fuelPerLap, d.fuelPerLap, 0.05, 100),
      tank: num(s.tank, d.tank, 1, 1000),
      reserve: num(s.reserve, d.reserve, 0, 10),
      pitLane: num(s.pitLane, d.pitLane, 0, 300),
      fuelRate: num(s.fuelRate, d.fuelRate, 0.1, 50),
      tireTime: num(s.tireTime, d.tireTime, 0, 300),
      tiresEvery: Math.round(num(s.tiresEvery, d.tiresEvery, 0, 20)),
      maxDrive: Math.round(num(s.maxDrive, d.maxDrive, 0, 600)),
      perTurn: Math.round(num(s.perTurn, d.perTurn, 1, 10)),
      balance: s.balance !== false,
      drivers: [],
      stints: [],
    };
    const seen = new Set();
    for (const [i, x] of (Array.isArray(s.drivers) ? s.drivers : d.drivers).entries()) {
      if (!x || typeof x !== 'object') continue;
      let id = /^[a-z0-9_-]{1,20}$/i.test(String(x.id || '')) ? String(x.id) : 'd' + (i + 1);
      while (seen.has(id)) id += 'x';
      seen.add(id);
      out.drivers.push({ id, name: String(x.name || '').slice(0, 40), color: HEX.test(x.color || '') ? x.color.toUpperCase() : COLORS[i % COLORS.length] });
      if (out.drivers.length >= 12) break;
    }
    if (!out.drivers.length) out.drivers = d.drivers.slice(0, 1);
    for (const x of (Array.isArray(s.stints) ? s.stints : []).slice(0, MAX_STINTS)) {
      const o = x && typeof x === 'object' ? x : {};
      out.stints.push({
        d: seen.has(o.d) ? o.d : null,
        laps: Number(o.laps) >= 1 ? Math.round(num(o.laps, null, 1, 2000)) : null,
        tires: typeof o.tires === 'boolean' ? o.tires : null,
      });
    }
    out.events = (Array.isArray(s.events) ? s.events : []).slice(0, 100).map((e, i) => {
      const o = e && typeof e === 'object' ? e : {};
      const kind = KINDS[o.kind] ? o.kind : 'pit';
      return {
        id: /^[a-z0-9_-]{1,20}$/i.test(String(o.id || '')) ? String(o.id) : 'e' + (i + 1),
        lap: Math.round(num(o.lap, 1, 1, 5000)), kind,
        repair: num(o.repair, 0, 0, 3600), penalty: num(o.penalty, 0, 0, 3600),
        lane: o.lane === true, refuel: (kind === 'pit' || kind === 'tow') && o.refuel !== false,
        tires: o.tires === true, change: o.change === 'next' ? 'next' : 'same',
        note: String(o.note || '').slice(0, 80),
      };
    }).sort((a, b) => a.lap - b.lap);
    while (out.stints.length && !out.stints[out.stints.length - 1].d && !out.stints[out.stints.length - 1].laps && out.stints[out.stints.length - 1].tires === null) out.stints.pop();
    return out;
  }

  // Runden mit einer Tankfüllung (ohne Reserve), begrenzt durch die längste Fahrzeit am Stück
  function lapsPerStint(p) {
    let n = Math.max(1, Math.floor(p.tank / p.fuelPerLap - p.reserve));
    if (p.maxDrive > 0) n = Math.min(n, Math.max(1, Math.floor((p.maxDrive * 60) / p.lapTime)));
    return n;
  }

  // Standzeit: Tanken und Reifenwechsel laufen gleichzeitig, dazu der Zeitverlust der Boxengasse
  const stopTime = (p, fuel, tires) => p.pitLane + Math.max(fuel / p.fuelRate, tires ? p.tireTime : 0);

  function compute(plan) {
    const p = normalize(plan);
    const max = lapsPerStint(p);
    let r = simulate(p, max);
    // gleichmässig verteilen: gleich viele Stopps, aber ähnlich lange Stints statt eines kurzen letzten Stints
    if (p.balance && r.stints.length > 1) {
      const even = Math.ceil(r.totalLaps / r.stints.length);
      if (even < max) {
        const r2 = simulate(p, even);
        if (r2.stints.length === r.stints.length) r = r2;
      }
    }
    r.perStint = max;
    return r;
  }

  // Zeitverlust eines Ereignisses, das den Stint nicht beendet
  function eventLoss(p, e) {
    if (e.kind === 'pit') return p.pitLane + e.repair;
    if (e.kind === 'tow') return e.penalty + e.repair;
    if (e.kind === 'penalty') return e.penalty + (e.lane ? p.pitLane : 0);
    return e.penalty;
  }

  function simulate(p, per) {
    const duration = (p.hours * 60 + p.minutes) * 60;
    const byId = Object.fromEntries(p.drivers.map((d) => [d.id, d]));
    const evs = p.events || [];
    const stints = [];
    let t = 0, lap = 0, fuel = 0;
    let pi = 0, slot = 0, ps = 0;   // geplanter Stint (für Anpassungen), Fahrer-Reihenfolge, geplante Stopps
    let pending = null, merged = []; // ungeplanter Stopp vor dem nächsten Stint / Ereignisse beim nächsten geplanten Stopp
    let prevDriver = null;
    const rest = (time) => (p.mode === 'laps' ? p.laps - lap : Math.max(1, Math.ceil((duration - time) / p.lapTime)));
    for (let i = 0; i < MAX_STINTS; i++) {
      if (p.mode === 'laps' ? lap >= p.laps : (i > 0 && t >= duration)) break;
      const cont = pending && pending.change === 'same';      // Fahrer bleibt nach dem ungeplanten Stopp im Auto
      const ov = cont ? {} : (p.stints[pi] || {});
      let tires = false;
      if (pending) tires = pending.tires;
      else if (i > 0) { ps++; tires = ov.tires ?? (p.tiresEvery > 0 && ps % p.tiresEvery === 0); }
      const want = (time) => Math.min(ov.laps || per, rest(time));
      const need = (L) => Math.min(p.tank, (L + p.reserve) * p.fuelPerLap);
      // Boxenstopp: Gasse (bzw. Abschleppen) + längste Arbeit (Tanken, Reifen, Reparatur) + Strafen beim Stopp
      const repair = pending ? pending.repair : merged.reduce((a, e) => Math.max(a, e.kind === 'pit' || e.kind === 'tow' ? e.repair : 0), 0);
      const base = pending ? (pending.kind === 'pit' ? p.pitLane : pending.penalty)
        : p.pitLane + merged.reduce((a, e) => a + (e.kind === 'tow' ? e.penalty : 0), 0);
      const stopT = (add) => base + Math.max(add / p.fuelRate, tires ? p.tireTime : 0, repair);
      let L = want(t), add = 0, stop = null, start = t;
      if (i === 0) fuel = need(L);
      else {
        for (let k = 0; k < 2; k++) {
          add = Math.max(0, Math.min(p.tank - fuel, need(L) - fuel));
          start = t + stopT(add);
          L = want(start);
        }
        add = Math.max(0, Math.min(p.tank - fuel, need(L) - fuel));
        stop = { fuel: add, tires, time: stopT(add), repair, event: pending, merged: merged.slice() };
        start = t + stop.time;
        fuel += add;
      }
      // Ereignisse in diesem Stint
      let inside = [], extra = 0, split = null, nextMerged = [];
      const scan = () => {
        inside = []; extra = 0; split = null; nextMerged = [];
        for (const e of evs) {
          if (e.lap <= lap || e.lap > lap + L) continue;
          const atStop = e.lap === lap + L;
          if ((e.kind === 'pit' || e.kind === 'tow') && e.refuel && !atStop) { split = e; break; }
          if ((e.kind === 'pit' || e.kind === 'tow') && atStop) { nextMerged.push(e); continue; }
          inside.push(e); extra += eventLoss(p, e);
        }
        if (split) L = split.lap - lap;
      };
      scan();
      // Zeitrennen, letzter Stint: Zeitverlust kostet Runden
      if (p.mode === 'time' && !split && L === rest(start) && extra > 0) {
        L = Math.max(1, Math.ceil((duration - start - extra) / p.lapTime));
        scan();
      }
      let driver;
      if (cont) driver = byId[prevDriver] || p.drivers[0];
      else { driver = (ov.d && byId[ov.d]) || p.drivers[Math.floor(slot / p.perTurn) % p.drivers.length]; slot++; }
      const fuelStart = fuel;
      fuel = Math.max(0, fuel - L * p.fuelPerLap);
      stints.push({
        i, pi: cont ? null : pi, driver: driver.id, laps: L, lapFrom: lap + 1, lapTo: lap + L,
        start, end: start + L * p.lapTime + extra, drive: L * p.lapTime + extra, extra, events: inside, endEvent: split,
        stop, fuelStart, fuelEnd: fuel, short: L * p.fuelPerLap > fuelStart + 0.01,
        manual: { d: !cont && !!(ov.d && byId[ov.d]), laps: !cont && !!ov.laps, tires: !cont && !pending && i > 0 && ov.tires !== null && ov.tires !== undefined },
      });
      if (!cont) pi++;
      prevDriver = driver.id;
      lap += L;
      t = start + L * p.lapTime + extra;
      pending = split;
      merged = nextMerged;
    }
    // Ereignisse beim letzten Stopp, nach dem Ziel: nur als Zeitverlust im letzten Stint
    const sum = p.drivers.map((d) => {
      const own = stints.filter((s) => s.driver === d.id);
      const time = own.reduce((a, s) => a + s.drive, 0);
      return { id: d.id, name: d.name, color: d.color, stints: own.length, laps: own.reduce((a, s) => a + s.laps, 0), time };
    });
    const driveTotal = sum.reduce((a, x) => a + x.time, 0) || 1;
    sum.forEach((x) => { x.share = x.time / driveTotal; });
    return {
      plan: p, perStint: per, stints, drivers: sum, totalLaps: lap, raceTime: t,
      stops: stints.length - 1, pitTime: stints.reduce((a, s) => a + (s.stop ? s.stop.time : 0), 0),
      fuelTotal: stints.reduce((a, s) => a + (s.stop ? s.stop.fuel : s.fuelStart), 0),
      tireSets: 1 + stints.filter((s) => s.stop && s.stop.tires).length,
      eventLoss: stints.reduce((a, s) => a + s.extra + (s.stop && (s.stop.event || s.stop.merged.length) ? Math.max(0, s.stop.time - stopTime(p, s.stop.fuel, s.stop.tires)) : 0), 0),
      unplanned: stints.filter((s) => s.stop && s.stop.event).length,
    };
  }

  // Name des Fahrers (leer → «Fahrer n»)
  const driverName = (plan, id) => {
    const i = plan.drivers.findIndex((d) => d.id === id);
    return i < 0 ? '' : plan.drivers[i].name || `Fahrer ${i + 1}`;
  };

  // Uhrzeit für eine Rennzeit (Sekunden ab Start), wenn eine Startzeit eingetragen ist
  function clockAt(plan, sec) {
    if (!plan.startTime) return '';
    const [h, m] = plan.startTime.split(':').map(Number);
    const t = Math.round(h * 3600 + m * 60 + sec);
    const day = Math.floor(t / 86400);
    const r = ((t % 86400) + 86400) % 86400;
    return `${String(Math.floor(r / 3600)).padStart(2, '0')}:${String(Math.floor((r % 3600) / 60)).padStart(2, '0')}${day > 0 ? ` (+${day})` : ''}`;
  }
  // Dauer als h:mm oder m:ss
  function dur(sec) {
    const t = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  // Rennzeit als h:mm:ss
  function raceClock(sec) {
    const t = Math.max(0, Math.round(sec || 0));
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  // Abgleich mit der laufenden Session (Frame aus dem Core)
  //   f.stint = { stops, stintLaps, lapCompleted, driver, onPit }, f.category, f.timer
  function live(calc, f) {
    if (!calc || !f || f.status === 'waiting' || f.category !== 'race' || !f.stint) return null;
    const s = f.stint, list = calc.stints;
    if (!list.length) return null;
    const lap = Math.max(0, s.lapCompleted || 0);
    // aktueller Stint nach Runden (erfasste Ereignisse verschieben den Plan entsprechend)
    let idx = list.findIndex((x) => lap + 1 <= x.lapTo);
    if (idx < 0) idx = list.length - 1;
    const cur = list[idx];
    const toStop = idx < list.length - 1 ? Math.max(0, cur.lapTo - lap) : null;
    let change = null;
    for (let j = idx + 1; j < list.length; j++) {
      if (list[j].driver !== cur.driver) {
        const inLaps = Math.max(0, list[j].lapFrom - 1 - lap);
        change = { stint: j, driver: list[j].driver, name: driverName(calc.plan, list[j].driver), inLaps, inSec: inLaps * calc.plan.lapTime };
        break;
      }
    }
    const tt = f.timer && f.timer.timeTotal > 0 && f.timer.timeRemain >= 0 ? f.timer.timeTotal - f.timer.timeRemain : null;
    // Abweichung zum Plan: wo sollte ich nach Plan jetzt sein (in Runden)?
    let planLap = null;
    if (tt !== null) {
      const st = list.find((x) => tt < x.end) || list[list.length - 1];
      planLap = tt < st.start ? st.lapFrom - 1 : Math.min(st.lapTo, st.lapFrom - 1 + (tt - st.start) / calc.plan.lapTime);
    }
    const planned = driverName(calc.plan, cur.driver);
    const actual = String(s.driver || '');
    const norm = (x) => x.toLowerCase().replace(/\s+/g, ' ').trim();
    const driverOk = !planned || !actual || norm(actual).includes(norm(planned)) || norm(planned).includes(norm(actual));
    return {
      idx, cur, lap, stintLaps: s.stintLaps, toStop, change, onPit: !!s.onPit,
      elapsed: tt, lapsAhead: planLap !== null ? lap - planLap : null,
      actualDriver: actual, plannedDriver: planned, driverOk,
    };
  }

  return { COLORS, KINDS, eventLoss, newPlan, normalize, compute, lapsPerStint, stopTime, driverName, clockAt, dur, raceClock, live };
});
