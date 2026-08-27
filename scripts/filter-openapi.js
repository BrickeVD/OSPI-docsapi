#!/usr/bin/env node
/**
 * Turns openapi/ospi-platform.raw.json (the unmodified spec exported from
 * ospi-platform's own SwaggerModule) into openapi/ospi-platform.json, the
 * one actually fed to docusaurus-plugin-openapi-docs. Two edits:
 *
 * 1. Drops entire tags (operations + any schema that becomes unreferenced
 *    as a result) that shouldn't be in the *public* API reference even
 *    though they're real backend routes — internal/ops-only surfaces.
 * 2. Strips "(ADR-030)" / "ADR-053: " / "see ADR-016" style citations out
 *    of description/summary text. The backend's Swagger decorators cite
 *    ADRs for the internal engineering audience; this site doesn't carry
 *    an Architecture section, so a citation into nothing is just noise
 *    for API consumers.
 *
 * Run this after refreshing openapi/ospi-platform.raw.json from the
 * backend, then `npm run gen-api-docs`.
 */
const fs = require('fs');
const path = require('path');

const RAW_PATH = path.resolve(__dirname, '../openapi/ospi-platform.raw.json');
const OUT_PATH = path.resolve(__dirname, '../openapi/ospi-platform.json');

// Real backend routes, deliberately excluded from the public API reference.
const EXCLUDED_TAGS = new Set([
  'admin', // platform-operator-only ops surface, not a third-party integration surface
  'unspsc', // internal catalog-import tooling, not something API consumers call
]);

function stripAdrMentions(text) {
  if (typeof text !== 'string' || !text.includes('ADR-')) return text;
  let t = text;
  // "(or its resource scope, ADR-023)" -> "(or its resource scope)"
  t = t.replace(/,\s*ADR-\d+(?:\s*,\s*ADR-\d+)*(?=\s*\))/g, '');
  // "(ADR-016)" / "(ADR-004, ADR-008)" standalone parenthetical -> removed
  t = t.replace(/\s*\(\s*ADR-\d+(?:\s*,\s*ADR-\d+)*\s*\)/g, '');
  // "ADR-053: recomputes..." at start -> "Recomputes..."
  t = t.replace(/^ADR-\d+(?:,\s*ADR-\d+)*:\s*/, (m) => '').replace(/^./, (c) => c.toUpperCase());
  // "ADR-053, platform-operator-only: ..." / "ADR-040, Deel 25 ..." at start
  t = t.replace(/^ADR-\d+(?:,\s*ADR-\d+)*,\s*/, '').replace(/^./, (c) => c.toUpperCase());
  // "ADR-041 — re-scopes ..." at start
  t = t.replace(/^ADR-\d+(?:,\s*ADR-\d+)*\s*[—-]\s*/, '').replace(/^./, (c) => c.toUpperCase());
  // "see ADR-030" / "See ADR-030" anywhere else still standing
  t = t.replace(/\bsee\s+ADR-\d+(?:(?:,|\s+and)\s*ADR-\d+)*\b/gi, '').replace(/\s{2,}/g, ' ');
  // any remaining bare "ADR-030" / "ADR-004, ADR-008" tokens
  t = t.replace(/ADR-\d+(?:\s*,\s*ADR-\d+)*/g, '');
  // whitespace/punctuation cleanup left behind by the removals above
  t = t
    .replace(/\(\s*\)/g, '') // empty parens
    .replace(/\s+([,.;:])/g, '$1') // space before punctuation
    .replace(/,\s*,/g, ',') // doubled commas
    .replace(/\s{2,}/g, ' ') // doubled spaces
    .replace(/\s+—\s*$/, '') // dangling trailing em-dash
    .replace(/\s+$/, '')
    .trim();
  return t;
}

function cleanDescriptionsAndSummaries(node) {
  if (Array.isArray(node)) {
    node.forEach(cleanDescriptionsAndSummaries);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'description' || key === 'summary') && typeof value === 'string') {
        node[key] = stripAdrMentions(value);
      } else {
        cleanDescriptionsAndSummaries(value);
      }
    }
  }
}

function collectSchemaRefs(node, refs) {
  if (Array.isArray(node)) {
    node.forEach((n) => collectSchemaRefs(n, refs));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const m = value.match(/^#\/components\/schemas\/(.+)$/);
        if (m) refs.add(m[1]);
      } else {
        collectSchemaRefs(value, refs);
      }
    }
  }
}

function main() {
  const spec = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));

  const droppedPaths = [];
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      const op = methods[method];
      const tags = op.tags || [];
      if (tags.some((t) => EXCLUDED_TAGS.has(t))) {
        delete methods[method];
      }
    }
    if (Object.keys(methods).length === 0) {
      delete spec.paths[p];
      droppedPaths.push(p);
    }
  }

  // Keep only schemas still reachable from what's left (transitive closure:
  // a kept schema can itself reference another schema).
  const keepSchemas = new Set();
  let frontier = new Set();
  collectSchemaRefs(spec.paths, frontier);
  while (frontier.size) {
    const next = new Set();
    for (const name of frontier) {
      if (keepSchemas.has(name)) continue;
      keepSchemas.add(name);
      const schema = spec.components.schemas[name];
      if (schema) collectSchemaRefs(schema, next);
    }
    frontier = new Set([...next].filter((n) => !keepSchemas.has(n)));
  }
  const droppedSchemas = Object.keys(spec.components.schemas).filter((n) => !keepSchemas.has(n));
  for (const name of droppedSchemas) delete spec.components.schemas[name];

  cleanDescriptionsAndSummaries(spec);

  fs.writeFileSync(OUT_PATH, JSON.stringify(spec, null, 2) + '\n');

  console.log(`Excluded tags: ${[...EXCLUDED_TAGS].join(', ')}`);
  console.log(`Dropped ${droppedPaths.length} path(s):`);
  droppedPaths.forEach((p) => console.log(`  - ${p}`));
  console.log(`Dropped ${droppedSchemas.length} now-unreferenced schema(s):`);
  droppedSchemas.forEach((s) => console.log(`  - ${s}`));
  console.log(`Wrote ${OUT_PATH}`);
}

main();
