'use strict';

const STORAGE_KEY = 'lfs.v1';
const DIFF_LABELS = { 1: 'лёгкий', 2: 'средний', 3: 'трудный' };

const state = {
  fallacies: new Map(), // id -> {id, name, latin, aliases, family, definition}
  families: [],
  noneId: 'none',
  questions: [],
  easter: [],     // пасхальные вопросы из data/easter.json — вне очереди, статистики и валидатора
  queue: [],
  current: null,  // {q, options, answered, pick, egg}
  session: { answered: 0, correct: 0, streak: 0 },
  store: { progress: {}, settings: {}, eggs: {} }, // eggs: id пасхалки -> {pick, ok, at}
};

// ---------- Хранилище ----------

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.store.progress = parsed.progress || {};
      state.store.settings = parsed.settings || {};
      state.store.eggs = parsed.eggs || {};
    }
  } catch (e) { /* приватный режим или повреждённые данные — начинаем с нуля */ }
}

function saveStore() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store)); } catch (e) { /* ignore */ }
}

function settings() {
  const s = state.store.settings;
  if (!s.mode) s.mode = 'all';
  if (!Array.isArray(s.types)) s.types = [...state.fallacies.keys()];
  if (!Array.isArray(s.diffs)) s.diffs = [1, 2, 3];
  if (typeof s.hideDisputed !== 'boolean') s.hideDisputed = false;
  return s;
}

// ---------- Загрузка данных ----------

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`не загрузился ${src}`));
    document.head.appendChild(s);
  });
}

async function loadData() {
  try {
    const [fallacies, questions, easter] = await Promise.all([
      fetchJson('data/fallacies.json'),
      fetchJson('data/questions.json'),
      fetchJson('data/easter.json').catch(() => []), // пасхалок может и не быть
    ]);
    return { fallacies, questions, easter };
  } catch (e) {
    // file:// — fetch недоступен, берём сборку из validate.js --write
    await loadScript('data/bundle.js');
    if (!window.LFS_DATA) throw e;
    return window.LFS_DATA;
  }
}

// ---------- Утилиты ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (id) => (state.fallacies.get(id) || { name: id }).name;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isMistake(q) {
  const p = state.store.progress[q.id];
  return Boolean(p && p.last === false);
}

function isNew(q) {
  return !state.store.progress[q.id];
}

// ---------- Очередь ----------

function matchesFilters(q) {
  const s = settings();
  if (!s.types.includes(q.answer_id)) return false;
  if (!s.diffs.includes(q.difficulty)) return false;
  if (s.hideDisputed && q.disputed) return false;
  return true;
}

function matchesMode(q) {
  const mode = settings().mode;
  if (mode === 'new') return isNew(q);
  if (mode === 'mistakes') return isMistake(q);
  return true;
}

function rebuildQueue() {
  state.queue = shuffle(state.questions.filter((q) => matchesFilters(q) && matchesMode(q)));
}

// Сколько раз за всё время ответили верно (частичный зачёт не считается).
function totalCorrect() {
  return Object.values(state.store.progress).reduce((sum, p) => sum + (p.ok || 0), 0);
}

// Пасхалка, которую пора показать: набрано нужное число верных ответов, а сама она ещё не отвечена.
function pendingEgg() {
  const total = totalCorrect();
  return state.easter.find((e) => !state.store.eggs[e.id] && total >= (e.unlock_correct || 0));
}

function nextQuestion() {
  const egg = pendingEgg();
  if (egg) {
    // Варианты-«ошибки нет» (last: true) остаются в конце, как обычный «ошибки нет».
    const idx = egg.options.map((o, i) => i);
    const options = [...shuffle(idx.filter((i) => !egg.options[i].last)), ...idx.filter((i) => egg.options[i].last)]
      .map(String);
    state.current = { q: egg, options, answered: false, pick: null, egg: true };
    renderQuestion();
    return;
  }
  // В режимах «новые» и «ошибки» вопрос мог перестать подходить после ответа.
  while (state.queue.length && !matchesMode(state.queue[0])) state.queue.shift();
  // Круг закончился: в «ошибках» остаются только неисправленные, в «новых» — ещё не отвеченные.
  if (!state.queue.length) rebuildQueue();
  const q = state.queue.shift();
  if (!q) {
    state.current = null;
    renderEmpty();
    return;
  }
  // Не показываем тот же вопрос дважды подряд при пересборке очереди.
  if (state.current && q.id === state.current.q.id && state.queue.length) {
    state.queue.push(q);
    return nextQuestion();
  }
  // Из пула отвлекающих: ближайший — всегда, остальные — случайно, всего 3.
  const pool = q.distractors.filter((id) => id !== q.nearest_distractor);
  const picked = q.distractors.includes(q.nearest_distractor) ? [q.nearest_distractor] : [];
  picked.push(...shuffle(pool).slice(0, 3 - picked.length));
  const options = shuffle([q.answer_id, ...picked].filter((id) => id !== state.noneId));
  if (q.offer_none || q.answer_id === state.noneId) options.push(state.noneId);
  state.current = { q, options, answered: false, pick: null };
  renderQuestion();
}

// ---------- Ответ ----------

function isAncestor(id, of) {
  for (let f = state.fallacies.get(of); f && f.parent; f = state.fallacies.get(f.parent)) {
    if (f.parent === id) return true;
  }
  return false;
}

// Пояснение к частичному зачёту: явное из also_accepted или общее для родительской категории.
function acceptedNote(q, id) {
  const explicit = (q.also_accepted || []).find((a) => a.id === id);
  if (explicit) return explicit.note;
  if (isAncestor(id, q.answer_id)) {
    return `«${nameOf(id)}» — общая категория, к которой относится «${nameOf(q.answer_id)}». Это верно, но в тренажёре засчитывается самый точный ярлык.`;
  }
  return null;
}

function submit() {
  const cur = state.current;
  if (!cur || cur.answered || cur.pick === null) return;
  cur.answered = true;
  if (cur.egg) {
    // Пасхалка — бонус: в счёт сессии и статистику не идёт, только запоминаем, что отвечена.
    const ok = Boolean(cur.q.options[cur.pick].correct);
    state.store.eggs[cur.q.id] = { pick: Number(cur.pick), ok, at: Date.now() };
    saveStore();
    renderEggFeedback(ok);
    return;
  }
  const ok = cur.pick === cur.q.answer_id;
  // Допустимый, но не самый точный ярлык (в том числе общая категория ответа): полбалла, в «ошибки» не попадает.
  const partial = !ok && Boolean(acceptedNote(cur.q, cur.pick));

  state.session.answered++;
  if (ok || partial) {
    state.session.correct += ok ? 1 : 0.5;
    state.session.streak++;
  } else {
    state.session.streak = 0;
  }

  const p = state.store.progress[cur.q.id] || { n: 0, ok: 0, first: ok };
  p.n++;
  if (ok) p.ok++;
  p.last = ok || partial;
  p.partial = partial;
  p.pick = cur.pick;
  p.at = Date.now();
  state.store.progress[cur.q.id] = p;
  saveStore();

  renderFeedback(ok, partial);
  renderScore();
}

// ---------- Отрисовка ----------

function renderScore() {
  const { answered, correct, streak } = state.session;
  $('#s-session').textContent = `${correct.toLocaleString('ru-RU')}/${answered}`;
  $('#s-streak').textContent = streak;
  const mastered = state.questions.filter((q) => state.store.progress[q.id] && state.store.progress[q.id].last).length;
  $('#s-mastered').textContent = `${mastered}/${state.questions.length}`;

  const filtered = state.questions.filter(matchesFilters);
  const nNew = filtered.filter(isNew).length;
  const nMis = filtered.filter(isMistake).length;
  $('#c-new').textContent = nNew ? `(${nNew})` : '';
  $('#c-mistakes').textContent = nMis ? `(${nMis})` : '';

  const s = settings();
  const total = state.fallacies.size;
  $('#c-filter').textContent = s.types.length < total || s.diffs.length < 3 || s.hideDisputed ? '•' : '';

  for (const btn of document.querySelectorAll('.mode')) {
    const on = btn.dataset.mode === s.mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on);
  }
}

function difficultyDots(d) {
  return `<span class="dots" title="Сложность: ${DIFF_LABELS[d]}">${'●'.repeat(d)}${'○'.repeat(3 - d)}</span>`;
}

function renderQuestion() {
  const { q, options, egg } = state.current;
  const disputed = q.disputed
    ? `<span class="badge warn" title="${esc((q.dispute_reasons || []).join('\n'))}">спорный</span>`
    : '';
  const seen = state.store.progress[q.id];
  const history = seen ? `<span class="badge">${seen.last ? 'уже решён' : 'был ошибкой'}</span>` : '';
  const meta = egg
    ? `<span class="badge egg" title="Бонус за ${q.unlock_correct || 0} верных ответов. В статистику не идёт.">🥚 пасхалка</span>`
    : `<span class="qid">${esc(q.id)}</span>${difficultyDots(q.difficulty)}${history}${disputed}`;
  // У пасхалки варианты — свои тексты (options[i].text), у обычного вопроса — id из справочника.
  const label = (id) => (egg ? q.options[id].text : nameOf(id));

  $('#card').innerHTML = `
    <div class="meta">${meta}</div>
    <blockquote class="text${egg ? ' dialog' : ''}" id="q-text">${esc(q.text)}</blockquote>
    <fieldset class="options">
      <legend>${esc(egg ? q.prompt : 'Какая ошибка допущена в сценке?')}</legend>
      ${options.map((id, i) => `
        <label class="option" data-id="${esc(id)}">
          <input type="radio" name="opt" value="${esc(id)}">
          <span class="key">${i + 1}</span>
          <span class="label">${esc(label(id))}</span>
          ${egg ? '' : '<button type="button" class="tip-btn" aria-label="Статья из справочника">?</button>'}
        </label>`).join('')}
      ${egg ? '' : '<div class="tip" id="tip" role="tooltip"></div>'}
    </fieldset>
    <div class="actions">
      <button type="button" class="primary" id="submit" disabled>Ответить</button>
    </div>
    <div id="feedback"></div>`;

  for (const input of document.querySelectorAll('input[name="opt"]')) {
    input.addEventListener('change', () => pick(input.value));
  }
  $('#submit').addEventListener('click', submit);
  if (!egg) bindOptionTips(); // у пасхалки варианты не из справочника — показывать нечего
}

// ---------- Всплывашка со статьёй справочника над вариантом ----------

// На компьютере — по наведению мыши. На телефоне mouseenter срабатывает по тапу
// и подсказка «залипала» бы, поэтому там вместо наведения кнопка «?» у варианта
// (она видна только на устройствах без мыши — см. .tip-btn в style.css).
const CAN_HOVER = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const TIP_DELAY = 350;    // мс: чтобы подсказки не мелькали, пока мышь едет через список
const TIP_MIN_WIDTH = 240; // px: уже этого справа от названий не помещаем — кладём под вариант
let tipTimer = null;

function hideTip() {
  clearTimeout(tipTimer);
  const el = $('#tip');
  if (el) el.classList.remove('show');
}

// Та же статья, что во вкладке «Справочник»: название, латынь, определение, синонимы.
function showTip(label) {
  const f = state.fallacies.get(label.dataset.id);
  const el = $('#tip');
  if (!f || !el) return;
  el.innerHTML = `
    <b>${esc(f.name)}</b>${f.latin ? ` <i class="latin">${esc(f.latin)}</i>` : ''}
    <p>${esc(f.definition)}</p>
    ${(f.aliases || []).length ? `<p class="muted">Также: ${esc(f.aliases.join(', '))}</p>` : ''}`;
  el.dataset.for = label.dataset.id;

  // Подсказка лежит внутри .options (position: absolute). Названия вариантов
  // короткие, справа у строк пусто — туда её и ставим, на уровне первого варианта,
  // чтобы она не закрывала ни одно название. Если места мало (узкий экран) —
  // под тем вариантом, к которому она относится.
  const box = el.parentElement.getBoundingClientRect();
  const labels = [...el.parentElement.querySelectorAll('.option')];
  const textRight = Math.max(...labels.map((l) => l.querySelector('.label').getBoundingClientRect().right));
  const left = textRight - box.left + 24;
  const width = box.width - left - 12;
  if (width >= TIP_MIN_WIDTH) {
    el.style.left = `${left}px`;
    el.style.width = `${width}px`;
    el.style.top = `${labels[0].offsetTop + 6}px`;
  } else {
    el.style.left = '0';
    el.style.width = '100%';
    el.style.top = `${label.offsetTop + label.offsetHeight + 6}px`;
  }
  el.classList.add('show');
}

function bindOptionTips() {
  hideTip();
  for (const label of document.querySelectorAll('.option')) {
    if (CAN_HOVER) {
      label.addEventListener('mouseenter', () => {
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => showTip(label), TIP_DELAY);
      });
      label.addEventListener('mouseleave', hideTip);
    }
    // «?» — показать/спрятать статью. preventDefault: кнопка внутри <label>,
    // тап по ней не должен выбирать вариант.
    label.querySelector('.tip-btn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = $('#tip');
      if (el.classList.contains('show') && el.dataset.for === label.dataset.id) hideTip();
      else showTip(label);
    });
  }
}
// Тап мимо «?» закрывает открытую статью.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tip-btn')) hideTip();
});

function pick(id) {
  const cur = state.current;
  if (!cur || cur.answered) return;
  cur.pick = id;
  const input = document.querySelector(`input[name="opt"][value="${CSS.escape(id)}"]`);
  if (input) input.checked = true;
  $('#submit').disabled = false;
}

function definitionLine(f) {
  const latin = f.latin ? ` <i class="latin">(${esc(f.latin)})</i>` : '';
  return `<p class="definition">${esc(f.definition)}${latin}</p>`;
}

function renderFeedback(ok, partial) {
  const { q, pick: chosen } = state.current;
  const answer = state.fallacies.get(q.answer_id);
  const accepted = partial ? { note: acceptedNote(q, chosen) } : null;

  // Подсветка цитаты в тексте
  const text = $('#q-text');
  const at = q.text.indexOf(q.highlight);
  if (at >= 0) {
    text.innerHTML = esc(q.text.slice(0, at)) + `<mark>${esc(q.highlight)}</mark>` + esc(q.text.slice(at + q.highlight.length));
  }

  for (const label of document.querySelectorAll('.option')) {
    const id = label.dataset.id;
    label.classList.toggle('correct', id === q.answer_id);
    label.classList.toggle('wrong', id === chosen && !ok && !partial);
    label.classList.toggle('partial', id === chosen && partial);
    label.querySelector('input').disabled = true;
  }

  const isNone = q.answer_id === state.noneId;
  const nearest = q.nearest_distractor;
  const nearestTitle = nearest === state.noneId ? '«ошибки нет»' : `«${nameOf(nearest)}»`;
  // При частичном зачёте ближайшего варианта его объяснит блок «засчитано частично».
  const nearestBlock = nearest && q.contrast && !(accepted && chosen === nearest)
    ? `<h3>${isNone ? `Почему это не ${nearestTitle}` : `Чем отличается от ${nearestTitle}`}</h3><p>${esc(q.contrast)}</p>`
    : '';
  // Пояснение к выбранному неверному варианту: адресная заметка автора, иначе определение.
  const pickNote = (q.pick_notes || {})[chosen]
    || (chosen === state.noneId && !isNone
      ? 'В сценке есть ошибка — ищите её в любой реплике, а не только у последнего или самого симпатичного говорящего. Ошибочная фраза подсвечена в тексте выше.'
      : (state.fallacies.get(chosen) || {}).definition);
  const pickedBlock = accepted
    ? `<h3>Почему «${esc(nameOf(chosen))}» засчитано частично</h3><p>${esc(accepted.note)}</p>`
    : !ok && (chosen !== nearest || (q.pick_notes || {})[chosen])
      ? `<h3>Вы выбрали «${esc(nameOf(chosen))}»</h3><p>${esc(pickNote || '')}</p>`
      : '';
  const disputedBlock = q.disputed
    ? `<p class="note">⚠ Пример помечен как спорный: ${esc((q.dispute_reasons || []).join(' '))}</p>`
    : '';
  const verdict = ok
    ? ['ok', 'Верно!']
    : partial ? ['partial', 'Частично верно.'] : ['bad', 'Неверно.'];
  const alt = ok && (q.also_accepted || []).length
    ? `<p class="note">Допустимо и «${esc(q.also_accepted.map((a) => nameOf(a.id)).join('», «'))}» — засчитывается частично.</p>`
    : '';

  $('#feedback').innerHTML = `
    <div class="verdict ${verdict[0]}">${verdict[1]} ${partial ? 'Точнее' : 'Правильный ответ'}: <b>${esc(answer.name)}</b></div>
    ${isNone ? '' : definitionLine(answer)}
    <h3>${isNone ? 'Ключевая фраза' : 'Где ошибка'}</h3>
    <p class="quote">«${esc(q.highlight)}»</p>
    <h3>${isNone ? 'Почему рассуждение корректно' : 'Почему это она'}</h3>
    <p>${esc(q.explanation)}</p>
    ${nearestBlock}
    ${pickedBlock}
    ${alt}
    ${disputedBlock}
    ${counterDetails(answer)}`;
  bindNextButton();
}

// Свёрнутый совет «как указать на это в споре» под разбором.
function counterDetails(f) {
  if (!f || !f.counter) return '';
  return `<details class="counter"><summary>Как указать на это в споре</summary>${counterBody(f.counter)}</details>`;
}

function counterBody(c) {
  return `<p>${esc(c.how)}</p>
    ${c.say.map((s) => `<p class="say">«${esc(s)}»</p>`).join('')}
    ${c.avoid ? `<p class="avoid"><b>Не надо:</b> ${esc(c.avoid)}</p>` : ''}`;
}

function renderEggFeedback(ok) {
  const { q, pick: chosen } = state.current;
  const right = q.options.findIndex((o) => o.correct);
  for (const label of document.querySelectorAll('.option')) {
    const i = Number(label.dataset.id);
    label.classList.toggle('correct', i === right);
    label.classList.toggle('wrong', i === Number(chosen) && !ok);
    label.querySelector('input').disabled = true;
  }
  const note = ok ? '' : q.options[chosen].note;
  // Абзацы разбора разделены пустой строкой.
  const paragraphs = q.explanation.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join('');
  $('#feedback').innerHTML = `
    <div class="verdict ${ok ? 'ok' : 'bad'}">${ok ? 'Верно!' : 'Неверно.'} Правильный ответ: <b>${esc(q.options[right].text)}</b></div>
    ${note ? `<h3>Вы выбрали «${esc(q.options[chosen].text)}»</h3><p>${esc(note)}</p>` : ''}
    <h3>Разбор</h3>
    ${paragraphs}
    <p><button type="button" class="link" id="egg-arguing">Открыть «Как спорить» →</button></p>`;
  $('#egg-arguing').addEventListener('click', () => showPanel('arguing'));
  bindNextButton();
}

// Кнопка «Ответить» превращается в «Дальше →».
function bindNextButton() {
  const btn = $('#submit');
  btn.textContent = 'Дальше →';
  btn.disabled = false;
  btn.replaceWith(btn.cloneNode(true));
  $('#submit').addEventListener('click', nextQuestion);
  $('#submit').focus();
}

function renderEmpty() {
  const mode = settings().mode;
  const msg = mode === 'mistakes'
    ? 'Ошибок для повторения нет — всё исправлено. 🎉'
    : mode === 'new'
      ? 'Новых вопросов не осталось. Переключитесь на «Все» или «Мои ошибки».'
      : 'Под выбранные фильтры не подходит ни один вопрос.';
  $('#card').innerHTML = `<p class="empty">${msg}</p>`;
}

// Типы, сгруппированные по семействам; «ошибки нет» — отдельной группой в конце.
function groupedFallacies() {
  const all = [...state.fallacies.values()];
  const groups = state.families.map((fam) => ({ name: fam.name, items: all.filter((f) => f.family === fam.id) }));
  const rest = all.filter((f) => !state.families.some((fam) => fam.id === f.family));
  if (rest.length) groups.push({ name: 'Без ошибки', items: rest });
  return groups.filter((g) => g.items.length);
}

function renderFilters() {
  const s = settings();
  $('#f-types').innerHTML = groupedFallacies().map((g) => `
    <div class="group"><h4>${esc(g.name)}</h4>${g.items.map((f) => {
      const n = state.questions.filter((q) => q.answer_id === f.id).length;
      return `<label class="check"><input type="checkbox" value="${esc(f.id)}" ${s.types.includes(f.id) ? 'checked' : ''}>
        ${esc(f.name)} <span class="muted">${n}</span></label>`;
    }).join('')}</div>`).join('');
  $('#f-diff').innerHTML = [1, 2, 3].map((d) =>
    `<label class="check"><input type="checkbox" value="${d}" ${s.diffs.includes(d) ? 'checked' : ''}> ${DIFF_LABELS[d]}</label>`).join('');
  $('#f-hide-disputed').checked = s.hideDisputed;
}

function renderGlossary() {
  $('#glossary').innerHTML = groupedFallacies()
    .filter((g) => g.items.some((f) => f.id !== state.noneId))
    .map((g) => `<h3>${esc(g.name)}</h3><dl>${g.items.map((f) => `
      <dt>${esc(f.name)}${f.latin ? ` <i class="latin">${esc(f.latin)}</i>` : ''}</dt>
      <dd>${esc(f.definition)}${(f.aliases || []).length ? `<br><span class="muted">Также: ${esc(f.aliases.join(', '))}</span>` : ''}</dd>`).join('')}</dl>`)
    .join('');
}

function renderArguing() {
  $('#arguing').innerHTML = groupedFallacies()
    .map((g) => ({ name: g.name, items: g.items.filter((f) => f.counter) }))
    .filter((g) => g.items.length)
    .map((g) => `<h3>${esc(g.name)}</h3><dl>${g.items.map((f) => `
      <dt>${esc(f.name)}</dt>
      <dd>${counterBody(f.counter)}</dd>`).join('')}</dl>`)
    .join('');
}

function renderStats() {
  $('#stats-body').innerHTML = groupedFallacies().flatMap((g) => g.items).map((f) => {
    const qs = state.questions.filter((q) => q.answer_id === f.id);
    const ps = qs.map((q) => state.store.progress[q.id]).filter(Boolean);
    const first = ps.filter((p) => p.first).length;
    const mistakes = ps.filter((p) => p.last === false).length;
    const pct = ps.length ? ` (${Math.round((first / ps.length) * 100)}%)` : '';
    return `<tr><td>${esc(f.name)}</td><td>${ps.length}/${qs.length}</td><td>${first}${pct}</td><td>${mistakes || ''}</td></tr>`;
  }).join('');
}

// ---------- События ----------

function applyFilterChange() {
  saveStore();
  rebuildQueue();
  renderScore();
  // Пасхалку фильтры не трогают — она ждёт ответа.
  const cur = state.current;
  if (!cur || cur.answered || (!cur.egg && !matchesFilters(cur.q))) nextQuestion();
}

// Панели — отдельные экраны: пока открыта панель, карточка вопроса скрыта. null — вернуться к вопросам.
function showPanel(name) {
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${name}`;
  for (const b of document.querySelectorAll('[data-panel]')) b.classList.toggle('active', b.dataset.panel === name);
  $('#main').hidden = Boolean(name);
  if (name === 'stats') renderStats();
  window.scrollTo(0, 0);
}

function bindUi() {
  for (const btn of document.querySelectorAll('.mode')) {
    btn.addEventListener('click', () => {
      settings().mode = btn.dataset.mode;
      saveStore();
      rebuildQueue();
      renderScore();
      nextQuestion();
    });
  }

  for (const btn of document.querySelectorAll('[data-panel]')) {
    btn.addEventListener('click', () => showPanel(btn.classList.contains('active') ? null : btn.dataset.panel));
  }
  for (const btn of document.querySelectorAll('.back')) btn.addEventListener('click', () => showPanel(null));
  // Выбор режима тоже возвращает к вопросам.
  for (const btn of document.querySelectorAll('.mode')) btn.addEventListener('click', () => showPanel(null));

  $('#f-types').addEventListener('change', () => {
    settings().types = [...document.querySelectorAll('#f-types input:checked')].map((i) => i.value);
    applyFilterChange();
  });
  $('#f-diff').addEventListener('change', () => {
    settings().diffs = [...document.querySelectorAll('#f-diff input:checked')].map((i) => Number(i.value));
    applyFilterChange();
  });
  $('#f-hide-disputed').addEventListener('change', (e) => {
    settings().hideDisputed = e.target.checked;
    applyFilterChange();
  });
  $('#f-all').addEventListener('click', () => {
    settings().types = [...state.fallacies.keys()];
    renderFilters();
    applyFilterChange();
  });
  $('#f-none').addEventListener('click', () => {
    settings().types = [];
    renderFilters();
    applyFilterChange();
  });

  $('#reset').addEventListener('click', () => {
    if (!confirm('Удалить весь сохранённый прогресс?')) return;
    state.store.progress = {};
    state.store.eggs = {};
    state.session = { answered: 0, correct: 0, streak: 0 };
    saveStore();
    renderStats();
    rebuildQueue();
    renderScore();
    nextQuestion();
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target.matches ? e.target : document.body;
    if (target.matches('input[type="checkbox"]') || e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter на кнопке и так нажмёт её — не обрабатываем дважды.
    if (e.key === 'Enter' && target.matches('button')) return;
    const cur = state.current;
    if (!cur || $('#main').hidden) return;
    if (/^[1-9]$/.test(e.key) && !cur.answered) {
      const id = cur.options[Number(e.key) - 1];
      if (id) pick(id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cur.answered) nextQuestion(); else submit();
    }
  });
}

// ---------- Старт ----------

async function init() {
  let data;
  try {
    data = await loadData();
  } catch (e) {
    $('#card').innerHTML = `<p class="empty">Не удалось загрузить данные. Запустите локальный сервер
      (<code>python -m http.server</code>) или соберите <code>data/bundle.js</code> командой
      <code>node scripts/validate.js --write</code>.</p>`;
    return;
  }
  state.noneId = data.fallacies.none_id || 'none';
  for (const f of data.fallacies.fallacies) state.fallacies.set(f.id, f);
  state.families = data.fallacies.families || [];
  state.questions = data.questions;
  state.easter = data.easter || [];

  loadStore();
  // Типы, добавленные в справочник позже, по умолчанию включены.
  const s = settings();
  const known = new Set(s.knownTypes || s.types);
  for (const id of state.fallacies.keys()) if (!known.has(id)) s.types.push(id);
  s.knownTypes = [...state.fallacies.keys()];
  saveStore();

  renderFilters();
  renderGlossary();
  renderArguing();
  bindUi();
  rebuildQueue();
  renderScore();
  nextQuestion();
}

init();
