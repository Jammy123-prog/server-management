#!/usr/bin/env node
// Assemble the final KnowledgeGraph from merged nodes/edges + layers + tour.
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const uaDir = path.join(root, '.ua');
const inter = path.join(uaDir, 'intermediate');

const merged = JSON.parse(fs.readFileSync(path.join(inter, 'assembled-graph.json'), 'utf8'));
const layers = JSON.parse(fs.readFileSync(path.join(inter, 'layers.json'), 'utf8'));
const tour = JSON.parse(fs.readFileSync(path.join(inter, 'tour.json'), 'utf8'));
const scan = JSON.parse(fs.readFileSync(path.join(inter, 'scan-result.json'), 'utf8'));

// --- normalize nodes -------------------------------------------------------
const seen = new Map();
const nodes = [];
for (const n of merged.nodes) {
  if (!n || !n.id) continue;
  if (seen.has(n.id)) { nodes[seen.get(n.id)] = n; continue; }
  seen.set(n.id, nodes.length);
  nodes.push(n);
}
const nodeIds = new Set(nodes.map(n => n.id));

// --- normalize edges -------------------------------------------------------
const edgeSeen = new Set();
const edges = [];
for (const e of merged.edges) {
  if (!e || !e.source || !e.target) continue;
  if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue; // drop dangling
  const key = `${e.source}|${e.target}|${e.type}`;
  if (edgeSeen.has(key)) continue;
  edgeSeen.add(key);
  edges.push(e);
}

// --- layers / tour: drop dangling refs ------------------------------------
const normLayers = layers
  .filter(l => l && l.id && l.name && Array.isArray(l.nodeIds))
  .map(l => ({ ...l, nodeIds: [...new Set(l.nodeIds.filter(id => nodeIds.has(id)))] }))
  .filter(l => l.nodeIds.length > 0);

const normTour = tour
  .filter(s => s && s.title && s.description && Array.isArray(s.nodeIds))
  .map(s => ({ ...s, nodeIds: [...new Set(s.nodeIds.filter(id => nodeIds.has(id)))] }))
  .filter(s => s.nodeIds.length > 0)
  .sort((a, b) => a.order - b.order);

const graph = {
  version: '1.0.0',
  project: {
    name: scan.projectName,
    languages: scan.languages,
    frameworks: scan.frameworks,
    description: scan.description,
    analyzedAt: new Date().toISOString(),
    gitCommitHash: '',
  },
  nodes,
  edges,
  layers: normLayers,
  tour: normTour,
};

fs.writeFileSync(path.join(inter, 'assembled-graph.json'), JSON.stringify(graph, null, 2));
console.log(`assembled: ${nodes.length} nodes, ${edges.length} edges, ${normLayers.length} layers, ${normTour.length} tour steps`);
