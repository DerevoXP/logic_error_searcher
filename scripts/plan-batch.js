#!/usr/bin/env node
// План следующей пачки из 50 вопросов: квоты по типам (с учётом уже накопленного
// перекоса), диапазон id и недоиспользуемые отвлекающие варианты.
//   node scripts/plan-batch.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'fallacies.json'), 'utf8'));
const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'questions.json'), 'utf8'));

const BATCH_SIZE = 50;
const NONE_SHARE = 0.1;
const NONE = ref.none_id || 'none';
const types = ref.fallacies.map((f) => f.id).filter((id) => id !== NONE);
const nameOf = (id) => ref.fallacies.find((f) => f.id === id).name;

const count = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
const asAnswer = count(questions.map((q) => q.answer_id));
const asDistractor = count(questions.flatMap((q) => q.distractors));

const nextBatch = Math.max(0, ...questions.map((q) => q.batch || 0)) + 1;
const maxNum = Math.max(0, ...questions.map((q) => Number(String(q.id).replace(/\D/g, '')) || 0));

const noneQuota = Math.round(BATCH_SIZE * NONE_SHARE);
// «Доливка»: каждое место отдаём типу, у которого сейчас меньше всего вопросов,
// так что недавно добавленные типы догоняют старые.
const quota = new Map(types.map((t) => [t, 0]));
const total = (t) => (asAnswer.get(t) || 0) + quota.get(t);
for (let slot = 0; slot < BATCH_SIZE - noneQuota; slot++) {
  const t = types.reduce((best, x) => (total(x) < total(best) ? x : best));
  quota.set(t, quota.get(t) + 1);
}

const pad = (n) => `q${String(n).padStart(3, '0')}`;
console.log(`Пачка ${nextBatch}: id ${pad(maxNum + 1)}–${pad(maxNum + BATCH_SIZE)}`);
console.log('Квоты (сейчас ответов → +в пачке):');
for (const t of types) {
  if (quota.get(t)) console.log(`  ${nameOf(t).padEnd(28)} ${String(asAnswer.get(t) || 0).padStart(3)} → +${quota.get(t)}`);
}
const skipped = types.filter((t) => !quota.get(t));
if (skipped.length) console.log(`  (в этой пачке не нужны: ${skipped.map(nameOf).join(', ')})`);
console.log(`  ${'Ошибки нет'.padEnd(28)} ${String(asAnswer.get(NONE) || 0).padStart(3)} → +${noneQuota}`);

const rare = [...types].sort((a, b) => (asDistractor.get(a) || 0) - (asDistractor.get(b) || 0)).slice(0, 5);
console.log(`Чаще ставить отвлекающими: ${rare.map((t) => `${nameOf(t)} (${asDistractor.get(t) || 0})`).join(', ')}`);
console.log('Сложность: примерно поровну 1/2/3; offer_none — примерно в трети вопросов с ошибкой.');
console.log('Пул distractors — 4 варианта из того же/соседнего семейства; спорные ярлыки — в also_accepted.');
console.log('Сюжеты не должны повторять имеющиеся: валидатор предупредит о похожих текстах.');
