// Online MUN server: zero dependencies. Real-time updates via Server-Sent Events,
// client actions via JSON POST. Live meetings are in memory; finished meeting
// records are written to ./records as JSON.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const COUNTRIES = require('./public/countries.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORDS_DIR = process.env.RECORDS_DIR || path.join(__dirname, 'records');
const HISTORY_LIMIT = 200;
const TRANSCRIPT_LIMIT = 5000;
const DISCONNECT_GRACE_MS = 15000;
const MAX_AI = 10;

const STAGES = [
  { id: 'setup', name: 'Conference Setup', hint: 'Set the topic and participating countries; delegates take their seats.' },
  { id: 'opening', name: 'Opening Speeches', hint: 'Each country delivers its opening statement.' },
  { id: 'motions', name: 'Motion Raising', hint: 'Delegates propose motions to the committee.' },
  { id: 'motionVote', name: 'Motion Voting', hint: 'The Chair puts motions to a vote, one vote per country.' },
  { id: 'caucus', name: 'Caucus / Debate', hint: 'Discussion based on the passed motions. Draft resolutions can be submitted.' },
  { id: 'resolution', name: 'Resolution / Final Vote', hint: 'Draft resolutions are finalised and put to a final vote.' },
  { id: 'results', name: 'Conference Results', hint: 'The meeting has ended. Review the record and results.' },
];
const STAGE = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));

const TOPICS = [
  'Maritime security in the Red Sea',
  'Regulating lethal autonomous weapons systems',
  'Climate-induced displacement and the protection of climate refugees',
  'Global governance of artificial intelligence',
  'Equitable access to vaccines in future pandemics',
  'Protecting critical undersea infrastructure',
  'Combating disinformation during elections',
  'Water security in transboundary river basins',
  'Sustainable debt relief for developing nations',
  'Preventing an arms race in outer space',
];
const COMMITTEES = [
  'Security Council',
  'General Assembly First Committee (DISEC)',
  'Human Rights Council',
  'Economic and Social Council',
  'UN Environment Assembly',
  'World Health Assembly',
];

/** committees: code -> committee (see createCommittee) */
const committees = new Map();

const id = () => crypto.randomBytes(12).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, max);
const cleanLine = (s, max) => clean(s, max).replace(/\n/g, ' ');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pick = (arr) => arr[crypto.randomInt(arr.length)];
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const canonicalCountry = (name) =>
  COUNTRIES.find((c) => c.name.toLowerCase() === String(name).trim().toLowerCase())?.name;

function newCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do code = Array.from({ length: 6 }, () => pick(alphabet)).join('');
  while (committees.has(code));
  return code;
}

const humans = (c) => [...c.participants.values()].filter((p) => !p.ai);
const label = (p) => (p.role === 'chair' ? `Chair ${p.name}` : p.ai ? `${p.country} (AI delegate)` : `${p.name} (${p.country})`);

function publicParticipant(p) {
  return { id: p.id, name: p.name, country: p.country, role: p.role, ai: !!p.ai, online: p.ai || p.streams.size > 0 };
}

function takenCountries(c) {
  return new Set([...c.participants.values()].filter((p) => p.role === 'delegate').map((p) => p.country));
}

function publicVote(c) {
  if (!c.vote) return null;
  const list = c.vote.kind === 'motion' ? c.motions : c.resolutions;
  const item = list.find((x) => x.id === c.vote.itemId);
  return {
    kind: c.vote.kind,
    itemId: c.vote.itemId,
    title: item ? item.title || item.text : '',
    ballots: c.vote.ballots,
    eligible: humans(c).filter((p) => p.role === 'delegate').map((p) => p.country),
  };
}

function publicState(c) {
  return {
    committee: {
      code: c.code,
      name: c.name,
      topic: c.topic,
      countries: c.countries,
      stage: c.stage,
      stages: STAGES,
      ended: c.stage === STAGE.results,
      recordId: c.recordId,
    },
    speakers: c.speakers,
    motions: c.motions,
    resolutions: c.resolutions,
    vote: publicVote(c),
  };
}

function snapshot(c, viewer) {
  return {
    ...publicState(c),
    me: publicParticipant(viewer),
    participants: [...c.participants.values()].map(publicParticipant),
    messages: c.messages.filter((m) => canSee(m, viewer)),
  };
}

function canSee(m, p) {
  if (m.type !== 'note') return true;
  return m.from.id === p.id || m.to.id === p.id;
}

function send(p, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of p.streams) res.write(payload);
}

function broadcast(c, event, data, filter = () => true) {
  for (const p of humans(c)) if (filter(p)) send(p, event, data);
}

function pushMessage(c, msg) {
  msg.id = id();
  msg.ts = Date.now();
  c.messages.push(msg);
  if (c.messages.length > HISTORY_LIMIT) c.messages.splice(0, c.messages.length - HISTORY_LIMIT);
  // Private notes never go into the meeting record.
  if (msg.type !== 'note' && c.transcript.length < TRANSCRIPT_LIMIT) c.transcript.push(msg);
  broadcast(c, 'message', msg, (p) => canSee(msg, p));
}

function system(c, text) {
  pushMessage(c, { type: 'system', text });
}

function syncRoster(c) {
  broadcast(c, 'roster', { participants: [...c.participants.values()].map(publicParticipant) });
}

function syncState(c) {
  broadcast(c, 'state', publicState(c));
}

function findSession(token) {
  if (!token) return null;
  for (const c of committees.values()) {
    const p = c.participants.get(token);
    if (p && !p.ai) return { c, p };
  }
  return null;
}

function addParticipant(c, fields) {
  const token = fields.ai ? `ai-${id()}` : id();
  const p = { id: id(), token, streams: new Set(), leaveTimer: null, ...fields };
  c.participants.set(token, p);
  c.roll.push({ name: p.name, country: p.country, role: p.role, ai: !!p.ai, joinedAt: Date.now() });
  return p;
}

function removeParticipant(c, token) {
  const p = c.participants.get(token);
  if (!p) return;
  c.participants.delete(token);
  clearTimeout(p.leaveTimer);
  for (const res of p.streams) res.end();
  c.speakers = c.speakers.filter((s) => s.id !== p.id);
  if (c.vote && p.role === 'delegate') delete c.vote.ballots[p.country];
  if (humans(c).length === 0) {
    committees.delete(c.code);
    return;
  }
  system(c, `${label(p)} has left the committee.`);
  syncRoster(c);
  syncState(c);
}

// ---------- Meeting records ----------

function buildRecord(c) {
  const chair = c.roll.find((r) => r.role === 'chair');
  const fmt = (m) => ({
    ts: m.ts,
    type: m.type,
    speaker: m.from ? (m.from.role === 'chair' ? `Chair ${m.from.name}` : m.from.ai ? `${m.from.country} (AI)` : `${m.from.country} (${m.from.name})`) : null,
    text: m.text,
  });
  return {
    id: c.recordId,
    code: c.code,
    committee: c.name,
    topic: c.topic,
    chair: chair ? chair.name : null,
    startedAt: c.createdAt,
    endedAt: c.endedAt,
    countries: c.countries,
    delegates: c.roll.filter((r) => r.role === 'delegate').map(({ name, country, ai }) => ({ country, name, ai })),
    stages: c.stageLog,
    motions: c.motions,
    resolutions: c.resolutions,
    transcript: c.transcript.map(fmt),
  };
}

function saveRecord(record) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RECORDS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
}

const RECORD_ID = /^[A-Z0-9]{6}-\d{10,16}$/;

function loadRecord(recordId) {
  if (!RECORD_ID.test(recordId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, `${recordId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function listRecords() {
  let files = [];
  try {
    files = fs.readdirSync(RECORDS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => loadRecord(f.slice(0, -5)))
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      committee: r.committee,
      topic: r.topic,
      chair: r.chair,
      endedAt: r.endedAt,
      delegations: r.delegates.length,
      resolutions: r.resolutions.map((x) => ({ title: x.title, status: x.status })),
    }))
    .sort((a, b) => b.endedAt - a.endedAt);
}

function recordToMarkdown(r) {
  const t = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const tally = (x) => (x.tally ? ` (${x.tally.yes} for, ${x.tally.no} against, ${x.tally.abstain} abstaining)` : '');
  const status = (s) => ({ passed: 'PASSED', failed: 'FAILED', pending: 'Not voted', voting: 'Vote interrupted' })[s] || s;
  const lines = [
    `# ${r.committee} — Meeting Record`,
    '',
    `- **Topic:** ${r.topic}`,
    `- **Meeting code:** ${r.code}`,
    `- **Chair:** ${r.chair || '—'}`,
    `- **Started:** ${t(r.startedAt)}`,
    `- **Ended:** ${t(r.endedAt)}`,
    `- **Participating countries:** ${r.countries.join(', ')}`,
    '',
    '## Delegations',
    ...r.delegates.map((d) => `- ${d.country} — ${d.ai ? 'AI delegate' : d.name}`),
    '',
    '## Proceedings',
    ...r.stages.map((s) => `- ${t(s.at)} — ${s.name}`),
    '',
    '## Motions',
    ...(r.motions.length ? r.motions.map((m) => `- **${status(m.status)}**${tally(m)} — ${m.text} _(moved by ${m.by.country})_`) : ['_No motions were raised._']),
    '',
    '## Resolutions',
  ];
  if (!r.resolutions.length) lines.push('_No draft resolutions were submitted._');
  for (const res of r.resolutions) {
    lines.push('', `### ${res.title} — ${status(res.status)}${tally(res)}`, `_Sponsored by ${res.by.country}_`, '', res.text);
  }
  lines.push('', '## Transcript', '');
  for (const m of r.transcript) {
    const time = new Date(m.ts).toISOString().slice(11, 16);
    if (m.type === 'system') lines.push(`- \`${time}\` _${m.text}_`);
    else {
      const tag = { announcement: ' [Announcement]', motion: ' [Motion]', resolution: ' [Draft resolution]' }[m.type] || '';
      lines.push(`- \`${time}\` **${m.speaker}**${tag}: ${m.text.replace(/\n/g, ' ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

function endMeeting(c, p) {
  if (c.vote) {
    const item = (c.vote.kind === 'motion' ? c.motions : c.resolutions).find((x) => x.id === c.vote.itemId);
    if (item) item.status = 'pending';
    c.vote = null;
  }
  c.stage = STAGE.results;
  c.endedAt = Date.now();
  c.recordId = `${c.code}-${c.endedAt}`;
  c.stageLog.push({ stage: 'results', name: STAGES[STAGE.results].name, at: c.endedAt });
  system(c, `${label(p)} has closed the meeting. The meeting record is now available.`);
  saveRecord(buildRecord(c));
  syncState(c);
}

// ---------- API handlers ----------

function autoConfig() {
  const countries = shuffle(COUNTRIES.map((c) => c.name)).slice(0, 10);
  return { committeeName: pick(COMMITTEES), topic: pick(TOPICS), countries, aiCount: 3 };
}

function create(body) {
  const name = cleanLine(body.name, 40);
  const committeeName = cleanLine(body.committeeName, 80);
  const topic = cleanLine(body.topic, 160);
  const countries = [...new Set((Array.isArray(body.countries) ? body.countries : []).map(canonicalCountry).filter(Boolean))];
  const aiCount = Math.floor(Number(body.aiCount) || 0);

  if (!name) return [400, { error: 'Your name is required.' }];
  if (!committeeName) return [400, { error: 'Committee name is required.' }];
  if (!topic) return [400, { error: 'Agenda topic is required.' }];
  if (countries.length < 2) return [400, { error: 'Choose at least 2 participating countries.' }];
  if (countries.length > 60) return [400, { error: 'At most 60 participating countries.' }];
  if (aiCount < 0 || aiCount > Math.min(MAX_AI, countries.length - 1)) {
    return [400, { error: `AI delegates must be between 0 and ${Math.min(MAX_AI, countries.length - 1)} (leave at least one seat for people).` }];
  }

  const hostKey = crypto.randomBytes(16).toString('hex');
  const c = {
    code: newCode(),
    name: committeeName,
    topic,
    countries,
    hostKeyHash: hash(hostKey),
    stage: STAGE.setup,
    stageLog: [{ stage: 'setup', name: STAGES[0].name, at: Date.now() }],
    participants: new Map(),
    roll: [],
    messages: [],
    transcript: [],
    speakers: [],
    motions: [],
    resolutions: [],
    vote: null,
    createdAt: Date.now(),
    endedAt: null,
    recordId: null,
  };
  committees.set(c.code, c);
  system(c, `${c.name} is now in session. Topic: ${c.topic}`);

  // AI delegates take randomly chosen seats among the participating countries.
  for (const country of shuffle(countries).slice(0, aiCount)) {
    addParticipant(c, { name: 'AI delegate', country, role: 'delegate', ai: true });
  }
  if (aiCount) system(c, `AI delegates seated: ${seatedCountries(c, true).join(', ')}.`);

  const chair = addParticipant(c, { name, country: 'Dais', role: 'chair' });
  return [200, { token: chair.token, code: c.code, hostKey }];
}

const seatedCountries = (c, ai) => [...c.participants.values()].filter((p) => !!p.ai === ai).map((p) => p.country);

function meetingInfo(code) {
  const c = committees.get(cleanLine(code, 12).toUpperCase());
  if (!c) return [404, { error: 'No meeting found with that code.' }];
  const taken = takenCountries(c);
  return [
    200,
    {
      code: c.code,
      name: c.name,
      topic: c.topic,
      stage: STAGES[c.stage].name,
      ended: c.stage === STAGE.results,
      recordId: c.recordId,
      available: c.countries.filter((x) => !taken.has(x)),
    },
  ];
}

function join(body) {
  const code = cleanLine(body.code, 12).toUpperCase();
  const name = cleanLine(body.name, 40);
  const c = committees.get(code);
  if (!c) return [404, { error: 'No meeting found with that code.' }];
  if (c.stage === STAGE.results) return [410, { error: 'This meeting has ended. Its record is on the home page.' }];
  if (!name) return [400, { error: 'Your name is required.' }];

  // The meeting creator holds the host key and rejoins as Chair.
  if (body.hostKey) {
    if (hash(body.hostKey) !== c.hostKeyHash) return [403, { error: 'Invalid host key for this meeting.' }];
    const p = addParticipant(c, { name, country: 'Dais', role: 'chair' });
    system(c, `${label(p)} has joined.`);
    syncRoster(c);
    return [200, { token: p.token, code }];
  }

  const country = canonicalCountry(body.country);
  if (!country || !c.countries.includes(country)) return [400, { error: 'Choose one of the participating countries.' }];
  if (takenCountries(c).has(country)) return [409, { error: `${country} is already represented in this committee.` }];

  const p = addParticipant(c, { name, country, role: 'delegate' });
  system(c, `${label(p)} has joined.`);
  syncRoster(c);
  syncState(c);
  return [200, { token: p.token, code }];
}

function act(body) {
  const s = findSession(body.token);
  if (!s) return [401, { error: 'Session expired. Please rejoin.' }];
  const { c, p } = s;
  const isChair = p.role === 'chair';
  const chairOnly = (what) => [403, { error: `Only the Chair can ${what}.` }];
  const inStage = (...ids) => ids.some((x) => c.stage === STAGE[x]);
  const stageError = (what, ...ids) => [400, { error: `${what} only during: ${ids.map((x) => STAGES[STAGE[x]].name).join(' or ')}.` }];

  if (c.stage === STAGE.results && body.action !== 'leave') return [400, { error: 'This meeting has ended.' }];

  switch (body.action) {
    case 'chat': {
      const text = clean(body.text, 1000);
      if (!text) return [400, { error: 'Empty message.' }];
      pushMessage(c, { type: 'chat', from: publicParticipant(p), text });
      break;
    }
    case 'note': {
      const text = clean(body.text, 1000);
      const target = [...c.participants.values()].find((x) => x.id === body.to);
      if (!text || !target) return [400, { error: 'Pick a recipient and write a note.' }];
      if (target.id === p.id) return [400, { error: "You can't pass a note to yourself." }];
      if (target.ai) return [400, { error: 'AI delegates cannot receive notes yet.' }];
      pushMessage(c, { type: 'note', from: publicParticipant(p), to: publicParticipant(target), text });
      break;
    }
    case 'announce': {
      if (!isChair) return chairOnly('make announcements');
      const text = clean(body.text, 1000);
      if (!text) return [400, { error: 'Empty announcement.' }];
      pushMessage(c, { type: 'announcement', from: publicParticipant(p), text });
      break;
    }
    case 'motion': {
      if (isChair) return [400, { error: 'Motions are raised by delegates.' }];
      if (!inStage('motions')) return stageError('Motions can be raised', 'motions');
      const text = cleanLine(body.text, 300);
      if (!text) return [400, { error: 'Describe your motion.' }];
      c.motions.push({ id: id(), text, by: { name: p.name, country: p.country }, status: 'pending', tally: null, ts: Date.now() });
      pushMessage(c, { type: 'motion', from: publicParticipant(p), text });
      syncState(c);
      break;
    }
    case 'resolution': {
      if (isChair) return [400, { error: 'Draft resolutions are sponsored by delegates.' }];
      if (!inStage('caucus', 'resolution')) return stageError('Draft resolutions can be submitted', 'caucus', 'resolution');
      const title = cleanLine(body.title, 120);
      const text = clean(body.text, 5000);
      if (!title || !text) return [400, { error: 'A draft resolution needs a title and operative text.' }];
      c.resolutions.push({ id: id(), title, text, by: { name: p.name, country: p.country }, status: 'pending', tally: null, ts: Date.now() });
      pushMessage(c, { type: 'resolution', from: publicParticipant(p), text: `Submitted draft resolution "${title}".` });
      syncState(c);
      break;
    }
    case 'openVote': {
      if (!isChair) return chairOnly('open a vote');
      if (c.vote) return [400, { error: 'Close the current vote first.' }];
      const kind = body.kind === 'resolution' ? 'resolution' : 'motion';
      if (kind === 'motion' && !inStage('motionVote')) return stageError('Motions are voted on', 'motionVote');
      if (kind === 'resolution' && !inStage('resolution')) return stageError('Resolutions are voted on', 'resolution');
      const item = (kind === 'motion' ? c.motions : c.resolutions).find((x) => x.id === body.id);
      if (!item) return [404, { error: 'That item no longer exists.' }];
      if (item.status !== 'pending') return [400, { error: 'That item has already been voted on.' }];
      item.status = 'voting';
      c.vote = { kind, itemId: item.id, ballots: {} };
      system(c, `The Chair opens voting on the ${kind === 'motion' ? 'motion' : 'draft resolution'}: "${item.title || item.text}".`);
      syncState(c);
      break;
    }
    case 'castVote': {
      if (isChair) return [400, { error: 'The Chair does not vote.' }];
      if (!c.vote) return [400, { error: 'There is no vote open.' }];
      if (!['yes', 'no', 'abstain'].includes(body.choice)) return [400, { error: 'Vote yes, no or abstain.' }];
      c.vote.ballots[p.country] = body.choice;
      syncState(c);
      break;
    }
    case 'closeVote': {
      if (!isChair) return chairOnly('close a vote');
      if (!c.vote) return [400, { error: 'There is no vote open.' }];
      const { ballots } = c.vote;
      const tally = { yes: 0, no: 0, abstain: 0 };
      for (const b of Object.values(ballots)) tally[b]++;
      const item = (c.vote.kind === 'motion' ? c.motions : c.resolutions).find((x) => x.id === c.vote.itemId);
      const kindLabel = c.vote.kind === 'motion' ? 'Motion' : 'Draft resolution';
      c.vote = null;
      if (item) {
        item.tally = tally;
        item.ballots = ballots;
        item.status = tally.yes > tally.no ? 'passed' : 'failed';
        system(c, `${kindLabel} "${item.title || item.text}" ${item.status === 'passed' ? 'PASSES' : 'FAILS'} — ${tally.yes} for, ${tally.no} against, ${tally.abstain} abstaining.`);
      }
      syncState(c);
      break;
    }
    case 'nextStage':
    case 'prevStage': {
      if (!isChair) return chairOnly('change the stage');
      if (c.vote) return [400, { error: 'Close the current vote first.' }];
      const next = c.stage + (body.action === 'nextStage' ? 1 : -1);
      if (next < 0) return [400, { error: 'Already at the first stage.' }];
      if (next >= STAGE.results) return [400, { error: 'Use "End meeting" to close the conference and generate the record.' }];
      c.stage = next;
      c.speakers = [];
      c.stageLog.push({ stage: STAGES[next].id, name: STAGES[next].name, at: Date.now() });
      system(c, `Stage ${next + 1}: ${STAGES[next].name} — ${STAGES[next].hint}`);
      syncState(c);
      break;
    }
    case 'endMeeting': {
      if (!isChair) return chairOnly('end the meeting');
      endMeeting(c, p);
      return [200, { ok: true, recordId: c.recordId }];
    }
    case 'raise': {
      if (isChair) return [400, { error: 'The Chair does not join the speakers list.' }];
      if (c.speakers.some((x) => x.id === p.id)) {
        c.speakers = c.speakers.filter((x) => x.id !== p.id);
      } else {
        c.speakers.push({ id: p.id, name: p.name, country: p.country });
      }
      syncState(c);
      break;
    }
    case 'nextSpeaker': {
      if (!isChair) return chairOnly('recognise speakers');
      const next = c.speakers.shift();
      if (next) system(c, `The Chair recognises the delegate of ${next.country} (${next.name}).`);
      syncState(c);
      break;
    }
    case 'clearSpeakers': {
      if (!isChair) return chairOnly('clear the speakers list');
      c.speakers = [];
      syncState(c);
      break;
    }
    case 'setTopic': {
      if (!isChair) return chairOnly('set the topic');
      const topic = cleanLine(body.topic, 160);
      if (!topic) return [400, { error: 'Topic cannot be empty.' }];
      c.topic = topic;
      system(c, `Topic set: ${topic}`);
      syncState(c);
      break;
    }
    case 'leave': {
      removeParticipant(c, p.token);
      break;
    }
    default:
      return [400, { error: 'Unknown action.' }];
  }
  return [200, { ok: true }];
}

function stream(req, res, token) {
  const s = findSession(token);
  if (!s) {
    res.writeHead(401).end();
    return;
  }
  const { c, p } = s;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  clearTimeout(p.leaveTimer);
  const wasOffline = p.streams.size === 0;
  p.streams.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(c, p))}\n\n`);
  if (wasOffline) syncRoster(c);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    p.streams.delete(res);
    if (p.streams.size > 0 || !c.participants.has(token)) return;
    syncRoster(c);
    // Give refreshes / flaky connections a moment before treating it as leaving.
    p.leaveTimer = setTimeout(() => removeParticipant(c, token), DISCONNECT_GRACE_MS);
  });
}

// ---------- HTTP plumbing ----------

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 32e3) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const POST_ROUTES = { '/api/create': create, '/api/join': join, '/api/action': act };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reply = ([status, body]) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'POST' && POST_ROUTES[url.pathname]) {
    try {
      return reply(POST_ROUTES[url.pathname](await readJson(req)));
    } catch {
      return reply([400, { error: 'Bad request.' }]);
    }
  }
  if (req.method !== 'GET') return res.writeHead(405).end();

  if (url.pathname === '/api/events') return stream(req, res, url.searchParams.get('token'));
  if (url.pathname === '/api/autoconfig') return reply([200, autoConfig()]);
  if (url.pathname === '/api/meeting') return reply(meetingInfo(url.searchParams.get('code')));
  if (url.pathname === '/api/records') return reply([200, listRecords()]);

  const m = url.pathname.match(/^\/api\/records\/([^/]+)(\/download)?$/);
  if (m) {
    const record = loadRecord(m[1]);
    if (!record) return reply([404, { error: 'Record not found.' }]);
    if (!m[2]) return reply([200, record]);
    const md = url.searchParams.get('format') !== 'json';
    res.writeHead(200, {
      'Content-Type': md ? 'text/markdown; charset=utf-8' : 'application/json',
      'Content-Disposition': `attachment; filename="mun-record-${record.id}.${md ? 'md' : 'json'}"`,
    });
    return res.end(md ? recordToMarkdown(record) : JSON.stringify(record, null, 2));
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => console.log(`MUN server running at http://localhost:${PORT}`));
