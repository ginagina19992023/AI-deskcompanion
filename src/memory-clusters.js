export const MEMORY_SEMANTIC_CLUSTER_THRESHOLD = 0.72;

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sourcePriority(source) {
  if (source === 'reflection') return 4;
  if (source === 'manual') return 3;
  if (source === 'chat') return 2;
  if (source === 'activity') return 1;
  return 0;
}

function representativeOrder(a, b) {
  return (
    sourcePriority(b.source) - sourcePriority(a.source) ||
    (b.importance ?? 1) - (a.importance ?? 1) ||
    (b.ts ?? 0) - (a.ts ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function categoriesCanMerge(a, b) {
  const categoryA = a || '其他';
  const categoryB = b || '其他';
  if (categoryA === categoryB) return true;
  const flexible = new Set(['项目', '事件', '其他']);
  return flexible.has(categoryA) && flexible.has(categoryB);
}

function averageEmbedding(members) {
  const vectors = members.map((m) => m.embedding).filter(Array.isArray);
  if (!vectors.length) return null;
  const size = vectors[0].length;
  if (!size || vectors.some((v) => v.length !== size)) return vectors[0];
  const mean = new Array(size).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < size; i++) mean[i] += vector[i] / vectors.length;
  }
  return mean;
}

function compactContextText(representative, members) {
  if (representative.source === 'reflection') return representative.text;
  const unique = [];
  for (const member of members) {
    const text = String(member.text || '').trim();
    if (text && !unique.includes(text)) unique.push(text);
    if (unique.length >= 4) break;
  }
  return unique.join('；');
}

export function buildSemanticMemoryGraph(
  facts,
  {
    clusterThreshold = MEMORY_SEMANTIC_CLUSTER_THRESHOLD,
    edgeThreshold = 0.6,
    maxEdgesPerNode = 4,
  } = {},
) {
  const input = Array.isArray(facts) ? facts : [];
  const byId = new Map(input.map((m) => [m.id, m]));
  const visible = input.filter((m) => !m.reflectedInto).sort(representativeOrder);
  const clusters = [];

  for (const fact of visible) {
    let best = null;
    let bestSimilarity = clusterThreshold;
    if (Array.isArray(fact.embedding)) {
      for (const cluster of clusters) {
        if (!categoriesCanMerge(cluster.representative.category, fact.category)) continue;
        const similarity = cosineSimilarity(fact.embedding, cluster.representative.embedding);
        if (similarity >= bestSimilarity) {
          best = cluster;
          bestSimilarity = similarity;
        }
      }
    }
    if (best) best.activeMembers.push(fact);
    else clusters.push({ representative: fact, activeMembers: [fact] });
  }

  const nodeForVisibleId = new Map();
  for (const cluster of clusters) {
    for (const member of cluster.activeMembers) nodeForVisibleId.set(member.id, cluster);
  }

  for (const fact of input) {
    if (!fact.reflectedInto) continue;
    const parentCluster = nodeForVisibleId.get(fact.reflectedInto);
    if (!parentCluster) continue;
    parentCluster.reflectedMembers ??= [];
    parentCluster.reflectedMembers.push(fact);
  }

  const nodes = clusters.map((cluster) => {
    const activeMembers = [...cluster.activeMembers].sort(representativeOrder);
    const representative = activeMembers[0];
    const reflectedMembers = cluster.reflectedMembers ?? [];
    const members = [...activeMembers, ...reflectedMembers];
    const explicitIds = representative.reflectsIds ?? [];
    const memberIds = [...new Set([...members.map((m) => m.id), ...explicitIds])];
    return {
      ...representative,
      embedding: averageEmbedding(activeMembers),
      contextText: compactContextText(representative, activeMembers),
      memberCount: memberIds.length,
      memberIds,
      clusterMembers: memberIds.map((id) => byId.get(id)).filter(Boolean),
    };
  });

  const seenEdges = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const scored = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const similarity = cosineSimilarity(nodes[i].embedding, nodes[j].embedding);
      if (similarity >= edgeThreshold) scored.push({ j, similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    for (const { j, similarity } of scored.slice(0, maxEdgesPerNode)) {
      const a = nodes[i].id < nodes[j].id ? nodes[i].id : nodes[j].id;
      const b = nodes[i].id < nodes[j].id ? nodes[j].id : nodes[i].id;
      const key = `${a}|${b}`;
      if (!seenEdges.has(key) || seenEdges.get(key).weight < similarity) {
        seenEdges.set(key, { a, b, weight: similarity });
      }
    }
  }

  return { nodes, edges: [...seenEdges.values()] };
}
