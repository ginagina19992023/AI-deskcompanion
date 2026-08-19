import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticMemoryGraph, cosineSimilarity } from '../src/memory-clusters.js';

const fact = (id, text, embedding, extra = {}) => ({
  id,
  text,
  embedding,
  category: '项目',
  importance: 2,
  ts: Number(id.replace(/\D/g, '')) || 1,
  source: 'chat',
  ...extra,
});

test('semantic memory graph folds related facts into one representative node', () => {
  const facts = [
    fact('r1', '研究机器人控制器', [1, 0]),
    fact('r2', '开发机械臂驱动', [0.98, 0.12]),
    fact('u3', '喜欢乌龙奶茶', [0, 1], { category: '喜好' }),
  ];
  const { nodes } = buildSemanticMemoryGraph(facts);
  assert.equal(nodes.length, 2);
  const robotics = nodes.find((n) => n.category === '项目');
  assert.equal(robotics.memberCount, 2);
  assert.deepEqual(new Set(robotics.memberIds), new Set(['r1', 'r2']));
  assert.match(robotics.contextText, /机器人控制器/);
  assert.match(robotics.contextText, /机械臂驱动/);
});

test('reflection replaces its source facts instead of adding more visible dots', () => {
  const facts = [
    fact('a1', '机器人事实一', [1, 0], { reflectedInto: 'summary' }),
    fact('a2', '机器人事实二', [0.99, 0.02], { reflectedInto: 'summary' }),
    fact('summary', '长期研究机器人系统', [1, 0], { source: 'reflection', reflectsIds: ['a1', 'a2'], importance: 3 }),
  ];
  const { nodes } = buildSemanticMemoryGraph(facts);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'summary');
  assert.equal(nodes[0].memberCount, 3);
});

test('similar facts in different categories remain separate', () => {
  const facts = [fact('p1', '机器人项目', [1, 0]), fact('h2', '机器人爱好', [1, 0], { category: '喜好' })];
  assert.equal(buildSemanticMemoryGraph(facts).nodes.length, 2);
});

test('project and other technical facts can merge despite noisy categorization', () => {
  const facts = [fact('p1', '机器人项目', [1, 0]), fact('o2', '机器人驱动开发', [0.99, 0.04], { category: '其他' })];
  const { nodes } = buildSemanticMemoryGraph(facts);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].memberCount, 2);
});

test('cosine similarity rejects incompatible or empty vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1], [1, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});
