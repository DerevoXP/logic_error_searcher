#!/usr/bin/env node
// Проверка данных тренажёра.
//   node scripts/validate.js          — только отчёт
//   node scripts/validate.js --write  — записать флаги спорности в questions.json и пересобрать data/bundle.js
//   node scripts/validate.js --verbose — показывать и мелкие заметки (известные пересечения без маркеров)
//
// Проходы:
//   1. Структура: обязательные поля, валидность id, highlight входит в текст, 2–6 предложений.
//   2. Дубли: одинаковые id, одинаковые/почти одинаковые тексты.
//   3. Баланс: распределение ответов по типам в целом и в каждой пачке.
//   4. Неоднозначность: каждый пример заново проверяется — нет ли в нём маркеров
//      другого ярлыка не слабее маркеров ответа, не попадает ли пара «ответ — отвлекающий»
//      в известное пересечение. Спорные получают disputed: true и dispute_reasons.
//
// data/easter.json (пасхальные вопросы) не проверяется — только кладётся в bundle.js как есть.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FALLACIES_PATH = path.join(ROOT, 'data', 'fallacies.json');
const QUESTIONS_PATH = path.join(ROOT, 'data', 'questions.json');
const BUNDLE_PATH = path.join(ROOT, 'data', 'bundle.js');
const EASTER_PATH = path.join(ROOT, 'data', 'easter.json');

const WRITE = process.argv.includes('--write');
const VERBOSE = process.argv.includes('--verbose');
const BATCH_SIZE = 50;
const NEAR_DUP_THRESHOLD = 0.5;
const PARAPHRASE_THRESHOLD = 0.2;

const errors = [];
const warnings = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
// \b в JS не считает кириллицу буквами — заменяем на явную границу слова.
const WORD_BOUNDARY = '(?:(?<=[а-яa-z0-9])(?![а-яa-z0-9])|(?<![а-яa-z0-9])(?=[а-яa-z0-9]))';
const compileCue = (c) => new RegExp(norm(c).split('\\b').join(WORD_BOUNDARY), 'u');

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Не удалось прочитать ${path.relative(ROOT, file)}: ${e.message}`);
    process.exit(2);
  }
}

const ref = loadJson(FALLACIES_PATH);
const questions = loadJson(QUESTIONS_PATH);
const NONE = ref.none_id || 'none';
const byId = new Map(ref.fallacies.map((f) => [f.id, f]));
const cues = new Map(ref.fallacies.map((f) => [f.id, (f.cues || []).map(compileCue)]));
const realTypes = ref.fallacies.map((f) => f.id).filter((id) => id !== NONE);
const nameOf = (id) => (byId.get(id) ? byId.get(id).name : id);
const familyById = new Map((ref.families || []).map((f) => [f.id, f]));
const overlapPairs = new Set((ref.overlaps || []).map((o) => o.pair.slice().sort().join('|')));
for (const f of ref.fallacies) {
  if (f.id !== NONE && !familyById.has(f.family)) err(f.id, `неизвестное семейство «${f.family}»`);
  if (f.parent && !byId.has(f.parent)) err(f.id, `неизвестная родительская категория «${f.parent}»`);
  // Совет для раздела «Как спорить»: how — тактика, say — непустой список фраз, avoid — необязательно.
  if (f.counter) {
    if (!f.counter.how || !Array.isArray(f.counter.say) || !f.counter.say.length) err(f.id, 'counter: нужны how и непустой say');
  } else if (f.id !== NONE) {
    warn(f.id, 'нет counter — тип не попадёт в раздел «Как спорить»');
  }
}
// Общая категория ответа засчитывается частично (как в приложении).
function isAncestor(id, of) {
  for (let f = byId.get(of); f && f.parent; f = byId.get(f.parent)) if (f.parent === id) return true;
  return false;
}

// ---------- 1. Структура ----------

function sentenceCount(text) {
  return text
    .split(/[.!?…]+[»"“]?(?=\s|$)/u)
    .filter((s) => /[а-яa-z]/i.test(s)).length;
}

const seenIds = new Set();
for (const [i, q] of questions.entries()) {
  const id = q.id || `#${i}`;
  for (const field of ['id', 'text', 'answer_id', 'distractors', 'highlight', 'explanation', 'difficulty']) {
    if (q[field] === undefined || q[field] === '') err(id, `нет поля ${field}`);
  }
  if (seenIds.has(q.id)) err(id, 'повторяющийся id');
  seenIds.add(q.id);

  if (!byId.has(q.answer_id)) err(id, `неизвестный answer_id «${q.answer_id}»`);
  if (!Array.isArray(q.distractors) || q.distractors.length < 3 || q.distractors.length > 6) {
    err(id, 'distractors — пул из 3–6 вариантов (в вопросе показываются 3)');
  } else {
    if (new Set(q.distractors).size !== q.distractors.length) err(id, 'distractors повторяются');
    for (const d of q.distractors) {
      if (!byId.has(d)) err(id, `неизвестный отвлекающий id «${d}»`);
      if (d === q.answer_id) err(id, 'правильный ответ продублирован в distractors');
      if (d === NONE) err(id, `«${NONE}» не кладётся в distractors — используйте offer_none`);
    }
  }
  if (q.answer_id === NONE && q.offer_none === false) err(id, `answer_id = ${NONE}, но offer_none = false`);

  const options = new Set([...(q.distractors || []), ...(q.offer_none || q.answer_id === NONE ? [NONE] : [])]);
  if (q.nearest_distractor !== undefined && !options.has(q.nearest_distractor)) {
    err(id, `nearest_distractor «${q.nearest_distractor}» не входит в показываемые варианты`);
  }
  if (!q.nearest_distractor || !q.contrast) warn(id, 'нет nearest_distractor/contrast — разбор не покажет отличие от ближайшего варианта');

  for (const a of q.also_accepted || []) {
    if (!a || !(q.distractors || []).includes(a.id)) err(id, `also_accepted «${a && a.id}» должен входить в distractors`);
    if (!a || !a.note) err(id, `also_accepted «${a && a.id}» без пояснения note`);
  }
  for (const key of Object.keys(q.pick_notes || {})) {
    if (!options.has(key)) err(id, `pick_notes для «${key}», которого нет среди вариантов`);
  }
  // Частный случай ответа среди вариантов: по правилу «самый точный ярлык» он был бы лучше ответа,
  // поэтому нужно объяснить, почему он не подходит (или засчитать частично).
  for (const d of q.distractors || []) {
    if (!isAncestor(q.answer_id, d)) continue;
    const explained = (q.also_accepted || []).some((a) => a.id === d) || (q.pick_notes || {})[d]
      || (d === q.nearest_distractor && q.contrast);
    if (!explained) err(id, `«${d}» — частный случай ответа; нужен pick_notes, also_accepted или contrast`);
  }

  // Отвлекающие должны быть правдоподобными: из того же или соседнего семейства,
  // из известного пересечения или ближайший по замыслу автора. Иначе их никто не выберет.
  const fam = byId.get(q.answer_id) && byId.get(q.answer_id).family;
  if (fam) {
    const near = new Set([fam, ...((familyById.get(fam) || {}).near || [])]);
    const close = (d) => near.has(byId.get(d).family) || d === q.nearest_distractor
      || overlapPairs.has([q.answer_id, d].sort().join('|'))
      || (q.also_accepted || []).some((a) => a.id === d) || (q.pick_notes || {})[d];
    const far = (q.distractors || []).filter((d) => byId.has(d) && !close(d));
    if (far.length > 1) warn(id, `отвлекающие из далёких семейств: ${far.join(', ')}`);
  }

  if (![1, 2, 3].includes(q.difficulty)) err(id, 'difficulty должен быть 1, 2 или 3');
  if (q.text && q.highlight && !q.text.includes(q.highlight)) err(id, 'highlight не найден в тексте дословно');
  if (q.text) {
    const n = sentenceCount(q.text);
    if (n < 2 || n > 6) warn(id, `в тексте ${n} предложений (ожидается 2–6)`);
  }
  if (q.batch === undefined) warn(id, 'нет номера пачки (batch)');
}

// ---------- 2. Дубли ----------

function shingles(text, k = 3) {
  const words = norm(text).replace(/[^а-яa-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(' '));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const sh = questions.map((q) => shingles(q.text || ''));
const textSeen = new Map();
for (const [i, q] of questions.entries()) {
  const key = norm(q.text || '').replace(/\s+/g, ' ').trim();
  if (textSeen.has(key)) err(q.id, `текст дословно совпадает с ${textSeen.get(key)}`);
  else textSeen.set(key, q.id);
  for (let j = 0; j < i; j++) {
    const sim = jaccard(sh[i], sh[j]);
    if (sim >= NEAR_DUP_THRESHOLD && key !== norm(questions[j].text || '').replace(/\s+/g, ' ').trim()) {
      err(q.id, `почти дубль ${questions[j].id} (сходство ${sim.toFixed(2)})`);
    }
  }
}

// Перефразирование: тот же сюжет другими словами. Сравниваем «основы» значимых слов
// (первые 5 букв слов от 5 букв) — грубо, но ловит общий набор персонажей и предметов.
function stems(text) {
  const words = norm(text).replace(/[^а-яa-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 5);
  return new Set(words.map((w) => w.slice(0, 5)));
}
const st = questions.map((q) => stems(q.text || ''));
for (let i = 0; i < questions.length; i++) {
  for (let j = 0; j < i; j++) {
    const sim = jaccard(st[i], st[j]);
    const sameAnswer = questions[i].answer_id === questions[j].answer_id;
    // Автор может пометить пару как проверенную: похожая форма, но разные сюжеты.
    const checked = (questions[i].not_paraphrase_of || []).includes(questions[j].id)
      || (questions[j].not_paraphrase_of || []).includes(questions[i].id);
    if (checked) continue;
    if (sim >= PARAPHRASE_THRESHOLD || (sameAnswer && sim >= PARAPHRASE_THRESHOLD * 0.75)) {
      warn(questions[i].id, `похож на ${questions[j].id} (общих основ ${sim.toFixed(2)}${sameAnswer ? ', тот же ответ' : ''}) — не перефразирование ли?`);
    }
  }
}

// ---------- 3. Баланс ----------

function countBy(list, keyFn) {
  const m = new Map();
  for (const x of list) m.set(keyFn(x), (m.get(keyFn(x)) || 0) + 1);
  return m;
}

const batches = countBy(questions, (q) => q.batch);
const balanceReport = [];
for (const b of [...batches.keys()].sort((a, b) => a - b)) {
  const inBatch = questions.filter((q) => q.batch === b);
  const counts = countBy(inBatch, (q) => q.answer_id);
  const real = realTypes.map((t) => counts.get(t) || 0);
  const min = Math.min(...real);
  const max = Math.max(...real);
  const none = counts.get(NONE) || 0;
  balanceReport.push(`  пачка ${b}: ${inBatch.length} вопр., на тип ${min}–${max}, «ошибки нет» ${none}`);
  // Последняя пачка может быть неполной — добивочной до нужного числа вопросов на тип.
  const isLast = b === Math.max(...batches.keys());
  if (inBatch.length > BATCH_SIZE || (inBatch.length < BATCH_SIZE && !isLast)) {
    warn(`batch ${b}`, `в пачке ${inBatch.length} вопросов (ожидается ${BATCH_SIZE})`);
  }
  if (none < inBatch.length * 0.05 || none > inBatch.length * 0.2) {
    warn(`batch ${b}`, `доля «ошибки нет» ${none}/${inBatch.length} вне диапазона 5–20%`);
  }
  const diff = countBy(inBatch, (q) => q.difficulty);
  for (const d of [1, 2, 3]) if (!diff.get(d)) warn(`batch ${b}`, `нет вопросов сложности ${d}`);
}

const totalCounts = countBy(questions, (q) => q.answer_id);
// Баланс считаем по всей базе: отдельные пачки могут намеренно догонять новые типы.
{
  const real = realTypes.map((t) => totalCounts.get(t) || 0);
  const min = Math.min(...real);
  const max = Math.max(...real);
  if (max - min > 1) {
    const lacking = realTypes.filter((t) => (totalCounts.get(t) || 0) === min);
    warn('баланс', `по типам ${min}–${max} вопросов; меньше всего (${lacking.length} типов): ${lacking.join(', ')}`);
  }
}
const distractorCounts = countBy(questions.flatMap((q) => q.distractors || []), (d) => d);

// ---------- 4. Неоднозначность ярлыка ----------

function cueScore(fid, q) {
  const hl = norm(q.highlight || '');
  const rest = norm((q.text || '').replace(q.highlight || '', ' '));
  let score = 0;
  for (const re of cues.get(fid) || []) {
    if (re.test(hl)) score += 2;
    else if (re.test(rest)) score += 1;
  }
  return score;
}

const overlapNote = new Map();
for (const o of ref.overlaps || []) {
  overlapNote.set(o.pair.slice().sort().join('|'), o.note);
}

const ambiguity = [];
for (const q of questions) {
  if (!byId.has(q.answer_id)) continue;
  const high = [];
  const low = [];
  // Варианты, засчитываемые частично, — уже разрешённая двусмысленность, их не проверяем.
  const accepted = new Set((q.also_accepted || []).map((a) => a.id));
  for (const d of q.distractors || []) if (isAncestor(d, q.answer_id)) accepted.add(d);
  const options = (q.distractors || []).filter((d) => byId.has(d) && !accepted.has(d));
  for (const a of q.also_accepted || []) low.push(`частичный зачёт: «${nameOf(a.id)}»`);

  if (q.answer_id === NONE) {
    for (const d of options) {
      const s = cueScore(d, q);
      if (s >= 3) high.push(`сильные маркеры «${nameOf(d)}» (${s}) при ответе «ошибки нет»`);
      else if (s > 0) low.push(`маркеры «${nameOf(d)}» (${s}) — убедиться, что рассуждение действительно корректно`);
    }
  } else {
    const a = cueScore(q.answer_id, q);
    if (a === 0) low.push('нет типичных маркеров ответа — ярлык держится только на разборе');
    for (const d of options) {
      const s = cueScore(d, q);
      if (s > 0 && s >= a) high.push(`маркеры «${nameOf(d)}» (${s}) не слабее маркеров ответа (${a})`);
      const note = overlapNote.get([q.answer_id, d].sort().join('|'));
      if (note && s > 0) high.push(`пересечение с «${nameOf(d)}»: ${note}`);
      else if (note) low.push(`известное пересечение с «${nameOf(d)}» (${note})`);
    }
  }
  if (q.contrast && q.contrast.length < 60) low.push('слишком короткий contrast');

  const review = q.review || {};
  if (review.status === 'disputed') high.unshift(`ревью: ${review.note || 'помечено вручную'}`);
  const suppressed = review.status === 'ok' && high.length > 0;
  const disputed = !suppressed && high.length > 0;

  ambiguity.push({ q, high, low, disputed, suppressed });
}

// ---------- Отчёт ----------

const line = '─'.repeat(64);
console.log(`${line}\nВопросов: ${questions.length}, типов ошибок: ${realTypes.length}, пачек: ${batches.size}`);
console.log(`${line}\nБаланс по пачкам:\n${balanceReport.join('\n')}`);
console.log(`${line}\nВсего по типам (ответ / как отвлекающий):`);
for (const t of [...realTypes, NONE]) {
  console.log(`  ${nameOf(t).padEnd(28)} ${String(totalCounts.get(t) || 0).padStart(3)} / ${String(distractorCounts.get(t) || 0).padStart(3)}`);
}

const disputed = ambiguity.filter((x) => x.disputed);
console.log(`${line}\nПроверка неоднозначности: спорных ${disputed.length} из ${questions.length}`);
for (const x of ambiguity) {
  const low = VERBOSE ? x.low : x.low.filter((r) => !r.startsWith('известное пересечение') && !r.startsWith('нет типичных'));
  if (!x.disputed && !x.suppressed && low.length === 0) continue;
  const mark = x.disputed ? '⚠ СПОРНЫЙ' : x.suppressed ? '✓ снято ревью' : '· заметка';
  console.log(`  ${x.q.id} [${nameOf(x.q.answer_id)}] ${mark}`);
  for (const r of x.high) console.log(`      ! ${r}`);
  for (const r of low) console.log(`      - ${r}`);
}

if (warnings.length) console.log(`${line}\nПредупреждения (${warnings.length}):\n  ${warnings.join('\n  ')}`);
if (errors.length) console.log(`${line}\nОШИБКИ (${errors.length}):\n  ${errors.join('\n  ')}`);
console.log(line);

// ---------- Запись ----------

// JSON.stringify, но короткие массивы строк остаются в одну строку.
function formatJson(data) {
  return JSON.stringify(data, null, 2).replace(/\[\s+("[^"\n]*"(?:,\s+"[^"\n]*")*)\s+\]/g, (m, inner) => {
    const flat = `[${inner.replace(/,\s+/g, ', ')}]`;
    return flat.length <= 100 ? flat : m;
  }) + '\n';
}

if (WRITE) {
  if (errors.length) {
    console.log('Есть ошибки — файлы не записаны.');
  } else {
    for (const x of ambiguity) {
      delete x.q.disputed;
      delete x.q.dispute_reasons;
      if (x.disputed) {
        x.q.disputed = true;
        x.q.dispute_reasons = x.high;
      }
    }
    fs.writeFileSync(QUESTIONS_PATH, formatJson(questions), 'utf8');
    const easter = fs.existsSync(EASTER_PATH) ? loadJson(EASTER_PATH) : [];
    const bundle = `// Сгенерировано scripts/validate.js --write. Нужен для открытия index.html без сервера (file://).\n` +
      `window.LFS_DATA = ${JSON.stringify({ fallacies: ref, questions, easter })};\n`;
    fs.writeFileSync(BUNDLE_PATH, bundle, 'utf8');
    console.log(`Записано: data/questions.json (спорных: ${disputed.length}), data/bundle.js`);
  }
}

process.exit(errors.length ? 1 : 0);
