// Team-Seite: verbindet sich über den Link (Teil nach «#») mit dem Team-Raum, zeigt Live-Daten und den
// Stint-Plan. Mit dem Bearbeiten-Link lässt sich der Plan ändern; jede Änderung ist signiert und geht sofort
// an alle (auch an OM Pitwall). Der Ansichts-Link kann nichts ändern.
/* global OMStint, OMTeam */
(function () {
  const SP = OMStint, T = OMTeam;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const I = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    pencil: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    eye: I('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    reset: I('<path d="M4 4v6h6"/><path d="M4.5 15a8 8 0 1 0 1.9-8.3L4 10"/>'),
    lock: I('<rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  };

  // ---------- Link lesen ----------
  const keys = T.parseLink(location.hash);
  const main = $('main');
  if (!keys) {
    document.body.classList.add('view');
    $('mode').hidden = true;
    $('conn').hidden = true;
    main.innerHTML = `<div class="wait"><h1>Ungültiger Team-Link</h1><p class="hint">Der Link ist unvollständig. Bitte den ganzen Link aus OM Pitwall kopieren (Stint-Planer → Team-Link).</p></div>`;
    return;
  }
  const EDIT = keys.mode === 'edit';
  document.body.classList.add(EDIT ? 'edit' : 'view');
  document.title = (EDIT ? 'Bearbeiten · ' : 'Ansicht · ') + 'Team-Stintplan – OM Pitwall';
  $('mode').className = 'mode ' + (EDIT ? 'edit' : 'view');
  $('mode').innerHTML = EDIT
    ? `${ICON.pencil}<div><b>BEARBEITEN</b><small>Änderungen gehen sofort ans ganze Team</small></div>`
    : `${ICON.eye}<div><b>NUR ANSICHT</b><small>Mit diesem Link kann nichts geändert werden</small></div>`;
  let myName = '';
  try { myName = localStorage.getItem('omteam.name') || ''; } catch { /* egal */ }
  if (EDIT) {
    $('meName').hidden = false;
    $('meInput').value = myName;
    $('meInput').addEventListener('change', (e) => { myName = e.target.value.trim().slice(0, 40); try { localStorage.setItem('omteam.name', myName); } catch { /* egal */ } });
  }

  // Test: eigene Vermittler nur auf dem eigenen Rechner (OM Pitwall liefert die Seite auch selbst aus)
  const local = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const qb = new URLSearchParams(location.search).get('brokers');
  const brokers = local && qb ? qb.split(',') : null;

  const room = new T.TeamRoom({ keys, WebSocket, brokers, role: EDIT ? 'edit' : 'view', name: myName });
  let doc = null, work = null, pubTimer = null, dirty = false;

  // ---------- Hilfen ----------
  const fmtLap = (s) => { if (!(s > 0)) return '–'; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
  const parseLap = (v) => { const t = String(v).trim().replace(',', '.'); const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : Number(t); };
  const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? `vor ${s} s` : s < 3600 ? `vor ${Math.round(s / 60)} min` : `vor ${Math.round(s / 3600)} h`; };
  const clock = (ts) => new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const plan = () => work || (doc ? SP.normalize(doc.plan) : null);
  let tt = null;
  const toast = (t) => { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('on'), 2200); };

  // ---------- Ändern (nur Bearbeiten-Link) ----------
  function change(fn) {
    if (!EDIT || !plan()) return;
    const p = JSON.parse(JSON.stringify(plan()));
    fn(p);
    work = SP.normalize(p);
    renderPlan(true);
    clearTimeout(pubTimer);
    pubTimer = setTimeout(publish, 350);
  }
  async function publish() {
    pubTimer = null;
    if (!work) return;
    try {
      doc = await room.publishPlan({ pid: doc ? doc.pid : '', by: myName || 'Team', plan: work });
      work = null;
      if (!room.status().online) toast('Gespeichert – wird gesendet, sobald die Verbindung steht');
      renderPlan();
    } catch (e) { toast('Nicht gespeichert: ' + e.message); }
  }
  const stintSlot = (p, pi) => { while (p.stints.length <= pi) p.stints.push({ d: null, laps: null, tires: null }); return p.stints[pi]; };

  main.addEventListener('change', (e) => {
    const el = e.target;
    if (!EDIT) return;
    const val = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.st) {
      const pi = Number(el.dataset.pi), k = el.dataset.st;
      change((p) => { const s = stintSlot(p, pi); s[k] = k === 'laps' ? (Number(val) >= 1 ? Math.round(Number(val)) : null) : val; });
    } else if (el.dataset.ev) {
      const i = Number(el.dataset.ei), k = el.dataset.ev;
      change((p) => {
        const ev = p.events[i];
        if (!ev) return;
        if (k === 'lap' || k === 'repair' || k === 'penalty') ev[k] = Number(String(val).replace(',', '.')) || 0;
        else ev[k] = val;
      });
    } else if (el.dataset.dr) {
      const i = Number(el.dataset.di), k = el.dataset.dr;
      change((p) => { if (p.drivers[i]) p.drivers[i][k] = val; });
    } else if (el.dataset.base) {
      const k = el.dataset.base;
      change((p) => {
        if (k === 'lapTime') { const v = parseLap(val); if (v > 0) p.lapTime = v; }
        else if (k === 'startTime' || k === 'name') p[k] = val;
        else if (k === 'balance') p.balance = !!val;
        else p[k] = Number(String(val).replace(',', '.'));
      });
    }
  });
  main.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !EDIT) return;
    const a = b.dataset.act;
    if (a === 'addEvent') {
      const L = liveCalc();
      change((p) => p.events.push({ id: 'e' + Math.random().toString(36).slice(2, 9), lap: L ? L.lap + 1 : 1, kind: 'pit', repair: 60, penalty: 0, lane: false, refuel: true, tires: false, change: 'same', note: myName ? `erfasst von ${myName}` : '' }));
    } else if (a === 'delEvent') {
      const i = Number(b.dataset.ei);
      if (confirm('Ereignis löschen?')) change((p) => p.events.splice(i, 1));
    } else if (a === 'addDriver') change((p) => p.drivers.push({ id: 'd' + Math.random().toString(36).slice(2, 7), name: '', color: SP.COLORS[p.drivers.length % SP.COLORS.length] }));
    else if (a === 'delDriver') {
      const i = Number(b.dataset.di);
      if (plan().drivers.length > 1 && confirm('Fahrer entfernen?')) change((p) => p.drivers.splice(i, 1));
    } else if (a === 'resetRow') change((p) => { if (p.stints[Number(b.dataset.pi)]) p.stints[Number(b.dataset.pi)] = { d: null, laps: null, tires: null }; });
    else if (a === 'mode') change((p) => { p.mode = b.dataset.v; });
  });
  // Während einer Eingabe nicht neu zeichnen (Fokus bleibt)
  main.addEventListener('focusout', () => setTimeout(() => { if (dirty && !busy()) renderPlan(); }, 0));
  const busy = () => main.contains(document.activeElement) && document.activeElement.matches('input, select');

  // ---------- Live ----------
  function bestLive() {
    const list = [...room.lives.values()];
    const fresh = (x) => Date.now() - x.ts < 120000 && x.status && x.status !== 'waiting';
    list.sort((a, b) => (fresh(b) - fresh(a)) || ((b.inCar === true) - (a.inCar === true)) || (b.ts - a.ts));
    return { main: list[0] || null, rest: list.slice(1) };
  }
  function liveCalc() {
    const p = plan();
    const l = bestLive().main;
    if (!p || !l || l.status === 'waiting') return null;
    return SP.live(SP.compute(p), { status: l.status, category: l.category, stint: l.stint, timer: l.timer });
  }
  function renderLive() {
    const box = $('live');
    if (!box) return;
    const { main: l, rest } = bestLive();
    if (!l) { box.innerHTML = '<p class="hint">Noch keine Live-Daten. Sie erscheinen, sobald jemand mit OM Pitwall (und dem Team-Link) fährt.</p>'; return; }
    const fresh = Date.now() - l.ts < 120000;
    if (l.status === 'waiting') {
      box.innerHTML = `<div class="lv-top"><span class="lv-k off">OFFLINE</span><span class="lv-drv">${esc(l.by || 'OM Pitwall')}</span><span class="lv-sub">wartet auf iRacing</span><span class="lv-age">${ago(l.ts)}</span></div>`;
      return;
    }
    const p = plan(), k = p ? SP.compute(p) : null;
    const L = k ? SP.live(k, { status: l.status, category: l.category, stint: l.stint, timer: l.timer }) : null;
    const tiles = [];
    const t = (label, val, sub, cls) => tiles.push(`<div class="tile ${cls || ''}"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`);
    t('Position', l.pos ? 'P' + l.pos : '–', l.cpos && l.cpos !== l.pos ? `Klasse P${l.cpos}` : l.cars ? `von ${l.cars}` : '');
    t('Runde', l.lap || '–', l.lapsRemain !== null && l.lapsRemain !== undefined ? `noch ${l.lapsRemain} Rd.` : '');
    t('Restzeit', l.timeRemain !== null && l.timeRemain !== undefined ? SP.raceClock(l.timeRemain) : '–', l.session || '');
    t('Sprit', l.fuel !== null && l.fuel !== undefined ? `${l.fuel.toFixed(1)} l` : '–', l.fuelLaps ? `reicht ${l.fuelLaps.toFixed(1)} Rd.` : '', l.fuelLaps !== null && l.fuelLaps < 2 ? 'warn' : '');
    t('Letzte Runde', fmtLap(l.last), l.best ? `Beste ${fmtLap(l.best)}` : '');
    t('Abstand', l.gapAhead !== null && l.gapAhead !== undefined ? `−${l.gapAhead.toFixed(1)} s` : '–', l.gapBehind !== null && l.gapBehind !== undefined ? `hinten +${l.gapBehind.toFixed(1)} s` : 'nach vorne');
    if (L) {
      const nx = k.stints[L.idx + 1];
      const inStint = Math.max(0, L.lap - (L.cur.lapFrom - 1));
      tiles.unshift(`<div class="tile hl"><span>Stint</span><b>${L.idx + 1} / ${k.stints.length}</b><small>Rd. ${Math.min(inStint, L.cur.laps)} von ${L.cur.laps}</small><div class="bar"><i style="width:${Math.min(100, (inStint / L.cur.laps) * 100).toFixed(1)}%"></i></div></div>`);
      t('Nächster Stopp', nx ? `in ${L.toStop} Rd.` : 'Ziel', nx ? `Runde ${L.cur.lapTo}${nx.stop ? ` · ${Math.round(nx.stop.fuel)} l${nx.stop.tires ? ' + Reifen' : ''}` : ''}` : 'kein Stopp mehr', L.onPit ? 'hl' : '');
      t('Fahrerwechsel', L.change ? esc(L.change.name) : '–', L.change ? `in ${L.change.inLaps} Rd.` : '', '');
      if (L.lapsAhead !== null) t('Gegenüber Plan', `${L.lapsAhead >= 0 ? '+' : ''}${L.lapsAhead.toFixed(1)} Rd.`, 'bei der aktuellen Rennzeit');
    }
    if (l.inc !== null && l.inc !== undefined) t('Incidents', l.inc + 'x', '');
    if (l.trackTemp !== null && l.trackTemp !== undefined) t('Strecke', `${l.trackTemp} °C`, l.airTemp !== null ? `Luft ${l.airTemp} °C` : '');
    const tag = l.demo ? '<span class="lv-k demo">DEMO</span>' : fresh ? '<span class="lv-k">LIVE</span>' : '<span class="lv-k off">ZULETZT</span>';
    const where = l.inCar === true ? 'im Auto' : l.inCar === false ? 'nicht im Auto' : '';
    box.innerHTML = `<div class="lv-top">${tag}<span class="lv-drv">${esc(l.by || '–')}</span>
      <span class="lv-sub">${esc([where, l.track, l.config, l.car].filter(Boolean).join(' · '))}</span>
      ${L && !L.driverOk ? `<span class="lv-sub" style="color:var(--loss)">Laut Plan fährt ${esc(L.plannedDriver)}</span>` : ''}
      <span class="lv-age">${ago(l.ts)}</span></div>
      <div class="tiles">${tiles.join('')}</div>
      ${rest.length ? `<p class="others">Ebenfalls verbunden: ${rest.map((x) => `${esc(x.by || 'OM Pitwall')} (${x.status === 'waiting' ? 'offline' : ago(x.ts)})`).join(' · ')}</p>` : ''}`;
  }

  // ---------- Plan ----------
  function skeleton() {
    main.innerHTML = `
      <section class="block"><h2>Live</h2><div class="live" id="live"></div></section>
      <section class="block"><h2>Plan<span class="sp"></span><span class="fh" id="planInfo"></span></h2><div class="kpis" id="kpis"></div></section>
      <div class="two">
        <section class="block"><h2>Stints${EDIT ? '<span class="sp"></span><span class="fh">Fahrer, Runden und Reifen je Stint ändern</span>' : ''}</h2><div class="tbl-wrap" id="stints"></div></section>
        <div style="display:grid;gap:16px;min-width:0">
          <section class="block"><h2>Unvorhergesehenes<span class="sp"></span>${EDIT ? `<button class="btn sm" data-act="addEvent">${ICON.plus}Ereignis erfassen</button>` : ''}</h2><div id="events"></div></section>
          <section class="block"><h2>Fahrer<span class="sp"></span>${EDIT ? `<button class="btn sm" data-act="addDriver">${ICON.plus}Fahrer</button>` : ''}</h2><div class="drivers" id="drivers"></div><div id="sum" style="margin-top:12px"></div></section>
          ${EDIT ? '<section class="block"><details><summary><h2>Grundwerte des Plans<span class="sp"></span><span class="fh">aufklappen</span></h2></summary><div class="grid2" id="base"></div></details></section>' : ''}
        </div>
      </div>`;
  }
  function renderPlan(fromEdit) {
    const p = plan();
    if (!p) return;
    if (!$('stints')) skeleton();
    if (busy() && !fromEdit) { dirty = true; return; }
    dirty = false;
    $('planName').textContent = p.name;
    const k = SP.compute(p);
    const L = liveCalc();
    const clk = (sec) => SP.clockAt(p, sec);
    const endClock = clk(k.raceTime);
    $('kpis').innerHTML = [
      ['Renndauer', p.mode === 'laps' ? `${p.laps} Rd.` : `${p.hours}:${String(p.minutes).padStart(2, '0')} h`, endClock ? `Ziel ca. ${endClock}` : (p.startTime ? `Start ${p.startTime}` : '')],
      ['Stints', k.stints.length, `${k.perStint} Rd. pro Tank`],
      ['Boxenstopps', k.stops, `${SP.dur(k.pitTime)} in der Box`],
      ['Runden', k.totalLaps, p.mode === 'time' ? 'geschätzt' : 'fest'],
      ['Ø Runde', fmtLap(p.lapTime), `${p.fuelPerLap.toFixed(2)} l/Rd. · Tank ${Math.round(p.tank)} l`],
      ['Reifensätze', k.tireSets, p.tiresEvery ? `Wechsel jeder ${p.tiresEvery}. Stopp` : 'kein Wechsel'],
    ].map(([a, b, c]) => `<div class="tile"><span>${a}</span><b>${b}</b><small>${c}</small></div>`).join('');
    $('planInfo').textContent = doc ? `Stand ${doc.rev} · ${doc.by ? 'geändert von ' + doc.by + ' · ' : ''}${clock(doc.ts)}${work ? ' · wird gespeichert …' : ''}` : '';
    const col = (id) => (p.drivers.find((d) => d.id === id) || {}).color;
    const name = (id) => SP.driverName(p, id);
    const opts = (sel) => p.drivers.map((d, i) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name || `Fahrer ${i + 1}`)}</option>`).join('');
    $('stints').innerHTML = `<table><thead><tr><th>#</th><th>Fahrer</th><th class="r">Runden</th><th class="r">von – bis</th><th class="r">Start</th><th class="r">Dauer</th><th class="r">Tanken</th><th class="c">Reifen</th><th class="r">Stopp</th>${EDIT ? '<th></th>' : ''}</tr></thead><tbody>
      ${k.stints.map((s) => {
        const cont = s.pi === null, ev = s.stop && s.stop.event;
        const ed = EDIT && !cont;
        const cls = L ? (s.i === L.idx ? 'cur' : s.i < L.idx ? 'past' : '') : '';
        return `<tr class="${cls}">
          <td>${s.i + 1}</td>
          <td>${ed ? `<span class="drv" style="--dc:${col(s.driver)}"><i></i><select class="in ${s.manual.d ? 'man' : ''}" data-st="d" data-pi="${s.pi}">${opts(s.driver)}</select></span>` : `<span class="drv" style="--dc:${col(s.driver)}"><i></i>${esc(name(s.driver))}</span>`}</td>
          <td class="r">${ed ? `<input class="in n ${s.manual.laps ? 'man' : ''}" type="text" inputmode="numeric" data-st="laps" data-pi="${s.pi}" value="${s.laps}" aria-label="Runden">` : s.laps}${s.short ? ' <span class="evt" title="Mehr Runden als eine Tankfüllung">!</span>' : ''}</td>
          <td class="r">${s.lapFrom} – ${s.lapTo}${s.endEvent ? `<small class="evt">${esc(SP.KINDS[s.endEvent.kind])} R${s.endEvent.lap}</small>` : ''}</td>
          <td class="r">${SP.raceClock(s.start)}${clk(s.start) ? `<small>${clk(s.start)}</small>` : ''}</td>
          <td class="r">${SP.dur(s.end - s.start)}${s.extra > 0.5 ? `<small class="evt">+${SP.dur(s.extra)} Ereignis</small>` : ''}</td>
          <td class="r">${s.stop ? `${Math.round(s.stop.fuel)} l` : `<small>Start ${Math.round(s.fuelStart)} l</small>`}</td>
          <td class="c">${s.stop ? (ed && !ev ? `<input type="checkbox" data-st="tires" data-pi="${s.pi}" ${s.stop.tires ? 'checked' : ''} aria-label="Reifen wechseln">` : s.stop.tires ? '✓' : '') : ''}</td>
          <td class="r">${s.stop ? SP.dur(s.stop.time) : ''}${ev ? '<small class="evt">ungeplant</small>' : ''}</td>
          ${EDIT ? `<td>${ed && (s.manual.d || s.manual.laps || s.manual.tires) ? `<button class="btn sm" data-act="resetRow" data-pi="${s.pi}" title="Wieder automatisch">${ICON.reset}</button>` : ''}</td>` : ''}</tr>`;
      }).join('')}</tbody></table>`;
    // Ereignisse
    const kinds = Object.entries(SP.KINDS);
    $('events').innerHTML = !p.events.length ? '<p class="hint">Keine Ereignisse – der Plan läuft wie vorgesehen.</p>' : p.events.map((e, i) => {
      const box = e.kind === 'pit' || e.kind === 'tow';
      if (!EDIT) {
        const parts = [`Runde ${e.lap}`];
        if (e.repair > 0) parts.push(`Reparatur ${SP.dur(e.repair)}`);
        if (e.penalty > 0) parts.push(`${e.kind === 'tow' ? 'Abschleppen' : 'Strafe'} ${SP.dur(e.penalty)}`);
        if (box && e.refuel) parts.push('volltanken' + (e.change === 'next' ? ', Fahrerwechsel' : ''));
        return `<div class="ev-ro"><b>${esc(SP.KINDS[e.kind])}</b><span>${parts.join(' · ')}</span>${e.note ? `<span class="fh">${esc(e.note)}</span>` : ''}</div>`;
      }
      return `<div class="ev">
        <label>Runde<input class="in" type="text" inputmode="numeric" data-ev="lap" data-ei="${i}" value="${e.lap}"></label>
        <label>Art<select class="in" data-ev="kind" data-ei="${i}">${kinds.map(([kk, l]) => `<option value="${kk}" ${kk === e.kind ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        ${box ? `<label>Reparatur (s)<input class="in" type="text" inputmode="decimal" data-ev="repair" data-ei="${i}" value="${e.repair}"></label>` : ''}
        ${e.kind !== 'pit' ? `<label>${e.kind === 'tow' ? 'Abschleppzeit (s)' : e.kind === 'penalty' ? 'Strafe (s)' : 'Zeitverlust (s)'}<input class="in" type="text" inputmode="decimal" data-ev="penalty" data-ei="${i}" value="${e.penalty}"></label>` : ''}
        ${e.kind === 'penalty' ? `<label class="chk"><input type="checkbox" data-ev="lane" data-ei="${i}" ${e.lane ? 'checked' : ''}>durch die Boxengasse</label>` : ''}
        ${box ? `<label class="chk"><input type="checkbox" data-ev="refuel" data-ei="${i}" ${e.refuel ? 'checked' : ''}>volltanken</label>
          <label class="chk"><input type="checkbox" data-ev="tires" data-ei="${i}" ${e.tires ? 'checked' : ''}>Reifen</label>
          <label>Danach fährt<select class="in" data-ev="change" data-ei="${i}"><option value="same" ${e.change === 'same' ? 'selected' : ''}>derselbe Fahrer</option><option value="next" ${e.change === 'next' ? 'selected' : ''}>der nächste Fahrer</option></select></label>` : ''}
        <label>Notiz<input class="in" type="text" maxlength="80" data-ev="note" data-ei="${i}" value="${esc(e.note)}"></label>
        <div><button class="btn sm danger" data-act="delEvent" data-ei="${i}">${ICON.trash}Löschen</button></div></div>`;
    }).join('');
    // Fahrer und Fahrzeit
    $('drivers').innerHTML = p.drivers.map((d, i) => EDIT
      ? `<div class="drow"><input type="color" data-dr="color" data-di="${i}" value="${d.color}" aria-label="Farbe"><input class="in" type="text" maxlength="40" data-dr="name" data-di="${i}" value="${esc(d.name)}" placeholder="Fahrer ${i + 1}">${p.drivers.length > 1 ? `<button class="btn sm danger" data-act="delDriver" data-di="${i}" title="Entfernen">${ICON.trash}</button>` : ''}</div>`
      : '').join('');
    const maxT = Math.max(...k.drivers.map((d) => d.time), 1);
    $('sum').innerHTML = k.drivers.map((d, i) => `<div style="display:grid;grid-template-columns:minmax(0,1fr) 2fr auto;gap:10px;align-items:center;padding:4px 0">
      <span class="drv" style="--dc:${d.color}"><i></i>${esc(d.name || `Fahrer ${i + 1}`)}</span>
      <span class="bar" style="margin:0"><i style="width:${((d.time / maxT) * 100).toFixed(1)}%;background:${d.color}"></i></span>
      <span class="fh" style="white-space:nowrap">${SP.dur(d.time)} h · ${d.stints} Stints</span></div>`).join('');
    // Grundwerte
    if ($('base')) {
      const f = (key, label, val, unit, hint) => `<label class="fld">${label}${unit ? ` (${unit})` : ''}<input class="in" type="text" inputmode="decimal" data-base="${key}" value="${esc(val)}">${hint ? `<span class="fh">${hint}</span>` : ''}</label>`;
      $('base').innerHTML = `
        <label class="fld">Name des Plans<input class="in" type="text" maxlength="60" data-base="name" value="${esc(p.name)}"></label>
        <div class="fld">Renndauer nach<div style="display:flex;gap:6px"><button class="btn sm ${p.mode === 'time' ? 'gold' : ''}" data-act="mode" data-v="time">Zeit</button><button class="btn sm ${p.mode === 'laps' ? 'gold' : ''}" data-act="mode" data-v="laps">Runden</button></div></div>
        ${p.mode === 'time' ? f('hours', 'Stunden', p.hours, 'h') + f('minutes', 'Minuten', p.minutes, 'min') : f('laps', 'Runden', p.laps, '')}
        <label class="fld">Startzeit (Ortszeit)<input class="in" type="time" data-base="startTime" value="${esc(p.startTime)}"></label>
        ${f('lapTime', 'Ø Rundenzeit', fmtLap(p.lapTime), '', 'z. B. 1:31.500')}
        ${f('fuelPerLap', 'Verbrauch pro Runde', p.fuelPerLap, 'l')}
        ${f('tank', 'Tankinhalt', p.tank, 'l')}
        ${f('reserve', 'Reserve', p.reserve, 'Rd.')}
        ${f('pitLane', 'Zeitverlust Boxengasse', p.pitLane, 's')}
        ${f('fuelRate', 'Tankgeschwindigkeit', p.fuelRate, 'l/s')}
        ${f('tireTime', 'Reifenwechsel', p.tireTime, 's')}
        ${f('tiresEvery', 'Reifen alle', p.tiresEvery, 'Stopps', '0 = nie')}
        ${f('perTurn', 'Stints am Stück je Fahrer', p.perTurn, '')}
        ${f('maxDrive', 'Längster Stint', p.maxDrive, 'min', '0 = so lange der Tank reicht')}
        <label class="chk"><input type="checkbox" data-base="balance" ${p.balance ? 'checked' : ''}>Stints gleichmässig verteilen</label>`;
    }
    renderLive();
  }

  // ---------- Verbindung ----------
  function renderConn() {
    const st = room.status();
    const el = $('conn');
    el.className = 'conn ' + (st.online ? 'ok' : 'bad');
    const peers = st.peers.filter((x) => x.id !== room.id);
    const n = { app: 0, edit: 0, view: 0 };
    for (const x of peers) n[x.role]++;
    const who = [n.app ? `${n.app} App` : '', n.edit ? `${n.edit} bearbeiten` : '', n.view ? `${n.view} schauen zu` : ''].filter(Boolean).join(', ');
    el.querySelector('span').textContent = st.online ? `Verbunden${who ? ' · ' + who : ''}` : 'Keine Verbindung – versuche erneut …';
    el.title = st.brokers.map((b) => `${b.url.replace(/^wss?:\/\//, '').split('/')[0]}: ${b.state === 'ok' ? 'verbunden' : 'getrennt'}`).join('\n');
  }
  room.on('status', renderConn);
  room.on('peers', renderConn);
  room.on('plan', (d) => {
    const first = !doc;
    doc = d;
    if (!pubTimer) work = null;
    if (!first && d.by && d.by !== myName) toast(`Plan aktualisiert${d.by ? ' von ' + d.by : ''}`);
    renderPlan();
  });
  room.on('live', () => { if (doc) renderLive(); });
  let closed = false;
  room.on('closed', () => {
    closed = true;
    doc = null; work = null; clearTimeout(pubTimer);
    $('planName').textContent = '–';
    main.innerHTML = '<div class="wait"><h1>Teilen beendet</h1><p class="hint">Der Ersteller hat das Teilen dieses Stint-Plans beendet oder neue Links erstellt.<br>Dieser Link ist nicht mehr gültig – bitte beim Team nach dem neuen Link fragen.</p></div>';
  });
  $('foot').innerHTML = `<span>${ICON.lock.replace('class="i"', 'class="i" style="width:14px;height:14px;vertical-align:-2px"')} Ende-zu-Ende verschlüsselt</span>
    <span>${EDIT ? 'Bearbeiten-Link: nur an Teammitglieder weitergeben, die den Plan ändern dürfen.' : 'Ansichts-Link: kann den Plan nicht ändern.'}</span>
    <span>OM Pitwall</span>`;
  room.start().then(() => {
    renderConn();
    setInterval(() => { renderConn(); if (doc && !closed) renderLive(); }, 2000);
    setTimeout(() => {
      if (doc || closed) return;
      main.innerHTML = `<div class="wait"><div class="spin"></div><h1>Noch kein Stint-Plan</h1><p class="hint">Der Plan erscheint, sobald OM Pitwall mit diesem Team-Link läuft.<br>Die Seite aktualisiert sich von selbst.</p></div>`;
    }, 9000);
  }).catch((e) => {
    main.innerHTML = `<div class="wait"><h1>Verbindung nicht möglich</h1><p class="hint">${esc(e.message)}<br>Bitte einen aktuellen Browser verwenden (Chrome, Edge, Firefox, Safari).</p></div>`;
  });
})();
