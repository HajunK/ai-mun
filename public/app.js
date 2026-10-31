(() => {
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const storage = {
    get(store, key) {
      try {
        return store.getItem(key);
      } catch {
        return null;
      }
    },
    set(store, key, value) {
      try {
        if (value == null) store.removeItem(key);
        else store.setItem(key, value);
      } catch {}
    },
  };
  // Host keys let the meeting creator rejoin their meeting as Chair from this device.
  const hostKeys = () => {
    try {
      return JSON.parse(storage.get(localStorage, 'mun-hosts') || '{}');
    } catch {
      return {};
    }
  };
  const saveHostKey = (code, key) => storage.set(localStorage, 'mun-hosts', JSON.stringify({ ...hostKeys(), [code]: key }));

  const state = {
    token: storage.get(sessionStorage, 'mun-token'),
    me: null,
    committee: null,
    participants: [],
    messages: [],
    speakers: [],
    motions: [],
    resolutions: [],
    vote: null,
    view: 'floor',
    unreadNotes: 0,
    source: null,
  };

  async function post(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch {
      return { error: 'Could not reach the server.' };
    }
  }
  async function get(url) {
    try {
      const r = await fetch(url);
      return await r.json();
    } catch {
      return { error: 'Could not reach the server.' };
    }
  }

  const action = async (name, payload = {}) => {
    const res = await post('/api/action', { token: state.token, action: name, ...payload });
    if (res.error) toast(res.error);
    return res;
  };

  // ---------- Routing ----------

  function show(viewId) {
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== viewId));
    window.scrollTo(0, 0);
  }

  function route() {
    if (state.source) return; // inside a meeting
    const [, page, arg] = location.hash.split('/');
    if (page === 'create') {
      show('create-view');
      if (!createState.countries.length) setSetup('auto');
    } else if (page === 'join') {
      show('join-view');
      if (arg) {
        findForm.code.value = decodeURIComponent(arg);
        findMeeting();
      }
    } else if (page === 'record' && arg) {
      show('record-view');
      loadRecord(decodeURIComponent(arg));
    } else {
      show('home-view');
      loadRecords();
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- Landing: meeting records ----------

  const fmtDate = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const statusLabel = { passed: 'Passed', failed: 'Failed', pending: 'Not voted', voting: 'Voting' };

  async function loadRecords() {
    const list = $('#records-list');
    const records = await get('/api/records');
    if (records.error) {
      list.replaceChildren(el('li', 'empty', records.error));
      return;
    }
    if (!records.length) {
      list.replaceChildren(el('li', 'empty', 'No meetings have ended yet. Records appear here when a Chair ends a meeting.'));
      return;
    }
    list.replaceChildren(
      ...records.map((r) => {
        const li = el('li', 'record-row');
        const text = el('div', 'record-text');
        const passed = r.resolutions.filter((x) => x.status === 'passed').length;
        text.append(
          el('strong', null, r.committee),
          el('span', null, r.topic),
          el('span', 'muted', `${fmtDate(r.endedAt)} · ${r.delegations} delegations · ${passed}/${r.resolutions.length} resolutions passed`)
        );
        const actions = el('div', 'record-row-actions');
        const view = el('a', 'button ghost small', 'View');
        view.href = `#/record/${encodeURIComponent(r.id)}`;
        const dl = el('a', 'button ghost small', 'Download');
        dl.href = `/api/records/${encodeURIComponent(r.id)}/download`;
        dl.setAttribute('download', '');
        actions.append(view, dl);
        li.append(text, actions);
        return li;
      })
    );
  }
  $('#refresh-records').addEventListener('click', loadRecords);

  async function loadRecord(id) {
    const body = $('#r-body');
    body.replaceChildren(el('p', 'muted', 'Loading…'));
    const r = await get(`/api/records/${encodeURIComponent(id)}`);
    if (r.error) {
      $('#r-title').textContent = 'Record not found';
      $('#r-topic').textContent = '';
      body.replaceChildren();
      return;
    }
    $('#r-title').textContent = r.committee;
    $('#r-topic').textContent = r.topic;
    $('#r-md').href = `/api/records/${encodeURIComponent(r.id)}/download`;
    $('#r-json').href = `/api/records/${encodeURIComponent(r.id)}/download?format=json`;

    const section = (title, ...children) => {
      const s = el('section', 'record-section');
      s.append(el('h2', null, title), ...children);
      return s;
    };
    const list = (items, render, empty) => {
      if (!items.length) return el('p', 'muted', empty);
      const ul = el('ul', 'record-list');
      ul.append(...items.map(render));
      return ul;
    };
    const tally = (x) => (x.tally ? ` · ${x.tally.yes} for, ${x.tally.no} against, ${x.tally.abstain} abstaining` : '');
    const statusPill = (s) => el('span', `status ${s}`, statusLabel[s] || s);

    const meta = el('dl', 'record-meta');
    for (const [k, v] of [
      ['Chair', r.chair || '—'],
      ['Meeting code', r.code],
      ['Started', fmtDate(r.startedAt)],
      ['Ended', fmtDate(r.endedAt)],
    ]) meta.append(el('dt', null, k), el('dd', null, v));

    const transcript = el('details', 'transcript');
    transcript.append(el('summary', null, `Full transcript (${r.transcript.length} entries)`));
    transcript.append(
      list(
        r.transcript,
        (m) => {
          const li = el('li', m.type === 'system' ? 'muted' : '');
          li.append(el('time', 'muted', new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), ' ');
          if (m.speaker) li.append(el('strong', null, m.speaker + ': '));
          li.append(m.text);
          return li;
        },
        'Empty.'
      )
    );

    body.replaceChildren(
      meta,
      section(
        'Delegations',
        list(r.delegates, (d) => el('li', null, `${window.flagFor(d.country)} ${d.country} — ${d.ai ? 'AI delegate' : d.name}`), 'None.')
      ),
      section(
        'Motions',
        list(
          r.motions,
          (m) => {
            const li = el('li');
            li.append(statusPill(m.status), ` ${m.text}`, el('span', 'muted', ` — moved by ${m.by.country}${tally(m)}`));
            return li;
          },
          'No motions were raised.'
        )
      ),
      section(
        'Resolutions',
        list(
          r.resolutions,
          (x) => {
            const li = el('li', 'record-resolution');
            const head = el('div');
            head.append(statusPill(x.status), ' ', el('strong', null, x.title), el('span', 'muted', ` — sponsored by ${x.by.country}${tally(x)}`));
            li.append(head, el('p', 'pre', x.text));
            return li;
          },
          'No draft resolutions were submitted.'
        )
      ),
      section('Proceedings', list(r.stages, (s) => el('li', null, `${fmtDate(s.at)} — ${s.name}`), '—')),
      transcript
    );
  }

  // ---------- Create meeting ----------

  const countryList = $('#countries');
  for (const c of window.COUNTRIES) {
    const opt = document.createElement('option');
    opt.value = c.name;
    countryList.append(opt);
  }

  const createForm = $('#create-form');
  const createState = { setup: 'auto', countries: [] };

  function setSetup(mode) {
    createState.setup = mode;
    createForm.dataset.setup = mode;
    document.querySelectorAll('[data-setup].tab').forEach((t) => {
      const active = t.dataset.setup === mode;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active);
    });
    for (const name of ['committeeName', 'topic', 'aiCount']) createForm[name].readOnly = mode === 'auto';
    if (mode === 'auto') loadAutoConfig();
    else renderChips();
  }
  document.querySelectorAll('.tab[data-setup]').forEach((t) => t.addEventListener('click', () => setSetup(t.dataset.setup)));

  async function loadAutoConfig() {
    const cfg = await get('/api/autoconfig');
    if (cfg.error) return ($('#create-error').textContent = cfg.error);
    createForm.committeeName.value = cfg.committeeName;
    createForm.topic.value = cfg.topic;
    createForm.aiCount.value = cfg.aiCount;
    createState.countries = cfg.countries;
    renderChips();
  }
  $('#shuffle').addEventListener('click', loadAutoConfig);

  function renderChips() {
    const manual = createState.setup === 'manual';
    $('#country-chips').replaceChildren(
      ...createState.countries.map((name) => {
        const li = el('li', 'chip');
        li.append(`${window.flagFor(name)} ${name}`);
        if (manual) {
          const x = el('button', 'chip-x', '×');
          x.type = 'button';
          x.title = `Remove ${name}`;
          x.addEventListener('click', () => {
            createState.countries = createState.countries.filter((n) => n !== name);
            renderChips();
          });
          li.append(x);
        }
        return li;
      })
    );
    $('#country-count').textContent = `(${createState.countries.length})`;
    createForm.aiCount.max = Math.max(0, Math.min(10, createState.countries.length - 1));
  }

  function addCountry() {
    const input = $('#country-input');
    const match = window.COUNTRIES.find((c) => c.name.toLowerCase() === input.value.trim().toLowerCase());
    if (!match) return toast('Pick a country from the list.');
    if (!createState.countries.includes(match.name)) createState.countries.push(match.name);
    input.value = '';
    renderChips();
  }
  $('#add-country').addEventListener('click', addCountry);
  $('#country-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCountry();
    }
  });

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#create-error').textContent = '';
    const res = await post('/api/create', {
      name: createForm.name.value,
      committeeName: createForm.committeeName.value,
      topic: createForm.topic.value,
      countries: createState.countries,
      aiCount: Number(createForm.aiCount.value),
    });
    if (res.error) return ($('#create-error').textContent = res.error);
    saveHostKey(res.code, res.hostKey);
    enterRoom(res.token);
    toast(`Meeting created. Share code ${res.code} with delegates.`);
  });

  // ---------- Join meeting ----------

  const findForm = $('#find-form');
  const joinForm = $('#join-form');
  let found = null;

  async function findMeeting() {
    $('#join-error').textContent = '';
    joinForm.hidden = true;
    const code = findForm.code.value.trim().toUpperCase();
    if (!code) return;
    const info = await get(`/api/meeting?code=${encodeURIComponent(code)}`);
    if (info.error) return ($('#join-error').textContent = info.error);
    if (info.ended) {
      $('#join-error').textContent = 'This meeting has ended.';
      if (info.recordId) location.hash = `#/record/${info.recordId}`;
      return;
    }
    found = info;
    found.hostKey = hostKeys()[info.code];
    $('#jp-name').textContent = info.name;
    $('#jp-topic').textContent = info.topic;
    $('#jp-stage').textContent = info.stage;
    $('#host-hint').hidden = !found.hostKey;
    joinForm.dataset.role = found.hostKey ? 'chair' : 'delegate';
    joinForm.country.required = !found.hostKey;
    joinForm.country.replaceChildren(
      new Option(info.available.length ? 'Choose your delegation…' : 'All seats are taken', ''),
      ...info.available.map((n) => new Option(`${window.flagFor(n)} ${n}`, n))
    );
    joinForm.hidden = false;
    joinForm.name.focus();
  }
  findForm.addEventListener('submit', (e) => {
    e.preventDefault();
    findMeeting();
  });

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#join-error').textContent = '';
    const res = await post('/api/join', {
      code: found.code,
      name: joinForm.name.value,
      country: joinForm.country.value,
      hostKey: found.hostKey,
    });
    if (res.error) {
      $('#join-error').textContent = res.error;
      if (res.error.includes('already represented')) findMeeting();
      return;
    }
    enterRoom(res.token);
  });

  // ---------- Realtime connection ----------

  function enterRoom(token) {
    state.token = token;
    storage.set(sessionStorage, 'mun-token', token);
    connect();
  }

  function connect() {
    if (state.source) state.source.close();
    const src = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
    state.source = src;
    let gotSnapshot = false;

    src.addEventListener('snapshot', (e) => {
      gotSnapshot = true;
      Object.assign(state, JSON.parse(e.data));
      showRoom();
      renderAll();
      setConn(true);
    });
    src.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      state.messages.push(msg);
      if (msg.type === 'note' && msg.from.id !== state.me.id && state.view !== 'notes') {
        state.unreadNotes++;
        renderBadge();
        toast(`Note from ${who(msg.from)}`);
      }
      if (matchesView(msg)) appendMessage(msg, true);
    });
    src.addEventListener('roster', (e) => {
      state.participants = JSON.parse(e.data).participants;
      renderRoster();
      renderVote();
    });
    src.addEventListener('state', (e) => {
      Object.assign(state, JSON.parse(e.data));
      renderMeeting();
    });
    src.onopen = () => setConn(true);
    src.onerror = () => {
      setConn(false);
      // Failing before any snapshot means the token is no longer valid (e.g. server restarted).
      if (!gotSnapshot) return resetToHome('Your session has ended.');
      // Otherwise EventSource retries on its own; if it gave up, start a fresh connection.
      if (src.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
    };
  }

  function setConn(ok) {
    const c = $('#conn');
    c.classList.toggle('offline', !ok);
    c.textContent = ok ? 'Live' : 'Reconnecting…';
  }

  function resetToHome(msg) {
    if (state.source) state.source.close();
    state.source = null;
    state.token = null;
    storage.set(sessionStorage, 'mun-token', null);
    delete document.body.dataset.role;
    delete document.body.dataset.ended;
    if (location.hash === '#/' || location.hash === '') route();
    else location.hash = '#/';
    if (msg) toast(msg);
  }

  // ---------- Room rendering ----------

  function showRoom() {
    show('room-view');
    document.body.dataset.role = state.me.role;
    if (location.hash !== '#/room') history.replaceState(null, '', '#/room');
  }

  const who = (p) => (p.role === 'chair' ? `Chair · ${p.name}` : p.country);
  const flag = (p) => (p.role === 'chair' ? '⚖️' : window.flagFor(p.country));
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const stageId = () => state.committee.stages[state.committee.stage].id;

  function renderAll() {
    renderMeeting();
    renderRoster();
    renderComposer();
    renderMessages();
    renderBadge();
  }

  function renderMeeting() {
    document.body.dataset.ended = state.committee.ended;
    document.body.dataset.stage = stageId();
    renderHeader();
    renderStages();
    renderSpeakers();
    renderItems();
    renderVote();
    renderEnded();
  }

  function renderHeader() {
    const c = state.committee;
    $('#c-code').textContent = c.code;
    $('#c-name').textContent = c.name;
    $('#c-topic').textContent = c.topic;
    $('#c-mode').textContent = c.stages[c.stage].name;
    document.title = `${c.name} · Online MUN`;
  }

  function renderStages() {
    const c = state.committee;
    $('#stages').replaceChildren(
      ...c.stages.map((s, i) => {
        const li = el('li', i < c.stage ? 'done' : i === c.stage ? 'current' : '', s.name);
        if (i === c.stage) li.setAttribute('aria-current', 'step');
        return li;
      })
    );
    $('#stage-hint').textContent = c.stages[c.stage].hint;
    const last = c.stages.length - 2; // the final stage is reached via "End meeting"
    $('#prev-stage').disabled = c.stage === 0 || c.ended;
    $('#next-stage').disabled = c.stage >= last || c.ended;
    $('#next-stage').textContent = c.stage < last ? `Next: ${c.stages[c.stage + 1].name}` : 'Next stage';
  }

  function renderSpeakers() {
    const list = $('#speakers');
    list.replaceChildren(
      ...state.speakers.map((s) => {
        const li = el('li');
        li.append(el('span', 'flag', window.flagFor(s.country)), el('span', null, s.country));
        if (s.id === state.me.id) li.classList.add('me');
        return li;
      })
    );
    $('#speakers-empty').hidden = state.speakers.length > 0;
    const queued = state.speakers.some((s) => s.id === state.me.id);
    $('#raise').textContent = queued ? 'Lower placard' : 'Raise placard';
    $('#raise').classList.toggle('raised', queued);
  }

  function renderItems() {
    const stage = stageId();
    const isChair = state.me.role === 'chair';
    const build = (items, kind, voteStage, empty) => {
      if (!items.length) return [el('li', 'muted empty-item', empty)];
      return items.map((x) => {
        const li = el('li', 'item');
        const head = el('div', 'item-head');
        head.append(el('span', `status ${x.status}`, statusLabel[x.status]), el('span', 'muted', `${window.flagFor(x.by.country)} ${x.by.country}`));
        li.append(head);
        if (kind === 'resolution') {
          const d = el('details');
          d.append(el('summary', null, x.title), el('p', 'pre', x.text));
          li.append(d);
        } else li.append(el('p', 'item-text', x.text));
        if (x.tally) li.append(el('p', 'muted small-text', `${x.tally.yes} for · ${x.tally.no} against · ${x.tally.abstain} abstaining`));
        if (isChair && x.status === 'pending' && stage === voteStage && !state.vote && !state.committee.ended) {
          const b = el('button', 'ghost small', 'Put to vote');
          b.type = 'button';
          b.addEventListener('click', () => action('openVote', { kind, id: x.id }));
          li.append(b);
        }
        return li;
      });
    };
    $('#motions').replaceChildren(...build(state.motions, 'motion', 'motionVote', 'No motions yet.'));
    $('#resolutions').replaceChildren(...build(state.resolutions, 'resolution', 'resolution', 'No draft resolutions yet.'));
    $('#motion-form').hidden = stage !== 'motions';
    $('#resolution-drafter').hidden = !['caucus', 'resolution'].includes(stage);
  }

  function renderVote() {
    const v = state.vote;
    $('#vote-banner').hidden = !v;
    if (!v) return;
    $('#vote-kind').textContent = v.kind === 'motion' ? 'Motion vote' : 'Final vote';
    $('#vote-title').textContent = v.title;
    const mine = v.ballots[state.me.country];
    const canVote = state.me.role === 'delegate' && v.eligible.includes(state.me.country);
    document.querySelectorAll('.vote-buttons button').forEach((b) => {
      b.classList.toggle('chosen', b.dataset.choice === mine);
      b.disabled = !canVote;
    });
    const counts = { yes: 0, no: 0, abstain: 0 };
    for (const c of Object.values(v.ballots)) counts[c]++;
    const voted = Object.keys(v.ballots).length;
    const tally = $('#vote-tally');
    const summary = el('span', null, `For ${counts.yes} · Against ${counts.no} · Abstain ${counts.abstain}`);
    summary.append(el('span', 'muted', ` — ${voted}/${v.eligible.length} delegations voted`));
    tally.replaceChildren(summary);
    const ballots = el('span', 'ballots');
    for (const [country, choice] of Object.entries(v.ballots)) {
      ballots.append(el('span', `ballot ${choice}`, `${window.flagFor(country)} ${country}`));
    }
    tally.append(ballots);
  }

  function renderEnded() {
    const c = state.committee;
    $('#ended-banner').hidden = !c.ended;
    if (c.recordId) $('#ended-record').href = `#/record/${encodeURIComponent(c.recordId)}`;
    $('#text').disabled = c.ended;
    $('#composer button[type=submit]').disabled = c.ended;
  }

  function renderRoster() {
    const sorted = [...state.participants].sort(
      (a, b) => (a.role === 'chair' ? -1 : 0) - (b.role === 'chair' ? -1 : 0) || a.country.localeCompare(b.country)
    );
    $('#roster').replaceChildren(
      ...sorted.map((p) => {
        const li = el('li', p.online ? '' : 'offline');
        li.append(el('span', 'flag', flag(p)));
        const text = el('div', 'roster-text');
        text.append(el('strong', null, p.role === 'chair' ? 'Chair' : p.country), el('span', 'muted', p.ai ? 'AI delegate · standby' : p.name));
        li.append(text);
        if (p.id === state.me.id) li.append(el('span', 'you', 'You'));
        else if (p.ai) li.append(el('span', 'ai-badge', 'AI'));
        else {
          const btn = el('button', 'ghost small', 'Note');
          btn.type = 'button';
          btn.title = `Pass a note to ${who(p)}`;
          btn.addEventListener('click', () => startNote(p.id));
          li.append(btn);
        }
        return li;
      })
    );
    $('#count').textContent = `(${state.participants.length})`;
    renderNoteTargets();
  }

  function renderComposer() {
    const opts = [['chat', 'Speak']];
    if (state.me.role === 'chair') opts.push(['announce', 'Announce']);
    opts.push(['note', 'Pass note']);
    const sel = $('#send-as');
    const prev = sel.value;
    sel.replaceChildren(...opts.map(([v, l]) => new Option(l, v)));
    if (opts.some(([v]) => v === prev)) sel.value = prev;
    syncComposer();
  }

  function renderNoteTargets() {
    const sel = $('#note-to');
    const prev = sel.value;
    const others = state.participants.filter((p) => p.id !== state.me?.id && !p.ai);
    sel.replaceChildren(
      new Option(others.length ? 'Choose recipient…' : 'No one else here yet', ''),
      ...others.map((p) => new Option(`${flag(p)} ${who(p)}`, p.id))
    );
    if (others.some((p) => p.id === prev)) sel.value = prev;
  }

  function syncComposer() {
    const kind = $('#send-as').value;
    $('#note-to').hidden = kind !== 'note';
    $('#text').placeholder =
      kind === 'note' ? 'Write a private note…' : kind === 'announce' ? 'Announcement to all delegates…' : 'Address the committee…';
    $('#composer').dataset.kind = kind;
  }

  const matchesView = (m) => (state.view === 'notes' ? m.type === 'note' : m.type !== 'note');

  function renderMessages() {
    const list = $('#messages');
    list.replaceChildren();
    const visible = state.messages.filter(matchesView);
    if (!visible.length) {
      list.append(
        el('li', 'empty', state.view === 'notes' ? 'No notes yet. Notes are private between you and one delegate.' : 'The floor is open.')
      );
    }
    visible.forEach((m) => appendMessage(m, false));
    list.scrollTop = list.scrollHeight;
  }

  function appendMessage(m, live) {
    const list = $('#messages');
    list.querySelector('.empty')?.remove();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;

    let li;
    if (m.type === 'system') {
      li = el('li', 'msg system', m.text);
    } else {
      li = el('li', `msg ${m.type}`);
      if (m.from.id === state.me.id) li.classList.add('mine');
      const head = el('div', 'msg-head');
      head.append(el('span', 'flag', flag(m.from)), el('strong', null, who(m.from)));
      if (m.type === 'note') {
        head.append(el('span', 'muted', '→'), el('strong', null, who(m.to)));
      } else if (m.from.role !== 'chair') {
        head.append(el('span', 'muted', m.from.name));
      }
      const tag = { announcement: 'Announcement', motion: 'Motion', note: 'Private note', resolution: 'Draft resolution' }[m.type];
      if (tag) head.append(el('span', 'tag', tag));
      head.append(el('time', 'muted', time(m.ts)));
      li.append(head, el('p', 'msg-body', m.text));
    }
    list.append(li);
    if (!live || nearBottom || m.from?.id === state.me.id) list.scrollTop = list.scrollHeight;
  }

  function renderBadge() {
    const b = $('#notes-badge');
    b.hidden = state.unreadNotes === 0;
    b.textContent = state.unreadNotes;
  }

  function setView(view) {
    state.view = view;
    if (view === 'notes') state.unreadNotes = 0;
    document.querySelectorAll('.chat-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    renderBadge();
    renderMessages();
  }

  function startNote(id) {
    $('#send-as').value = 'note';
    syncComposer();
    $('#note-to').value = id;
    setView('notes');
    document.body.classList.remove('show-roster');
    $('#text').focus();
  }

  // ---------- Room interactions ----------

  document.querySelectorAll('.chat-tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#send-as').addEventListener('change', () => {
    syncComposer();
    if ($('#send-as').value === 'note') setView('notes');
  });

  const text = $('#text');
  const autosize = () => {
    text.style.height = 'auto';
    text.style.height = Math.min(text.scrollHeight, 160) + 'px';
  };
  text.addEventListener('input', autosize);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = text.value.trim();
    if (!body) return;
    const kind = $('#send-as').value;
    const payload = { text: body };
    if (kind === 'note') {
      payload.to = $('#note-to').value;
      if (!payload.to) return toast('Choose who should receive the note.');
    }
    const res = await action(kind, payload);
    if (!res.error) {
      text.value = '';
      autosize();
    }
  });

  $('#motion-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#motion-input');
    if (!input.value.trim()) return;
    const res = await action('motion', { text: input.value });
    if (!res.error) {
      input.value = '';
      setView('floor');
    }
  });

  $('#resolution-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await action('resolution', { title: $('#res-title').value, text: $('#res-text').value });
    if (!res.error) {
      $('#res-title').value = '';
      $('#res-text').value = '';
      $('#resolution-drafter').open = false;
    }
  });

  $('#topic-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#topic-input');
    if (!input.value.trim()) return;
    const res = await action('setTopic', { topic: input.value });
    if (!res.error) input.value = '';
  });

  document.querySelectorAll('.vote-buttons button').forEach((b) =>
    b.addEventListener('click', () => action('castVote', { choice: b.dataset.choice }))
  );
  $('#close-vote').addEventListener('click', () => action('closeVote'));
  $('#next-stage').addEventListener('click', () => action('nextStage'));
  $('#prev-stage').addEventListener('click', () => action('prevStage'));
  $('#end-meeting').addEventListener('click', () => {
    if (confirm('End the meeting for everyone and generate the meeting record?')) action('endMeeting');
  });

  $('#raise').addEventListener('click', () => action('raise'));
  $('#next-speaker').addEventListener('click', () => action('nextSpeaker'));
  $('#clear-speakers').addEventListener('click', () => {
    if (confirm('Clear the entire speakers list?')) action('clearSpeakers');
  });
  $('#toggle-panel').addEventListener('click', () => document.body.classList.toggle('show-roster'));

  $('#copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.committee.code);
      toast('Meeting code copied.');
    } catch {
      toast(`Meeting code: ${state.committee.code}`);
    }
  });

  $('#ended-record').addEventListener('click', (e) => {
    e.preventDefault();
    const href = e.currentTarget.getAttribute('href');
    resetToHome();
    if (href) location.hash = href;
  });

  $('#leave').addEventListener('click', async () => {
    if (!state.committee.ended && !confirm('Leave this committee?')) return;
    if (state.source) state.source.close();
    await action('leave');
    resetToHome();
  });

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // Old-style invite links (?code=XYZ) open the Join screen.
  const legacyCode = new URLSearchParams(location.search).get('code');
  if (legacyCode) history.replaceState(null, '', `/#/join/${encodeURIComponent(legacyCode)}`);

  // Resume an existing session after a page refresh; otherwise show the routed page.
  if (state.token) connect();
  else route();
})();
