#!/usr/bin/env node
// Merge the official scan-project output with the narrative fields + importMap,
// then emit the fingerprint input for build-fingerprints.mjs.
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const uaDir = path.join(root, '.ua');
const official = JSON.parse(fs.readFileSync(path.join(uaDir, 'tmp', 'scan-official.json'), 'utf8'));
const previous = JSON.parse(fs.readFileSync(path.join(uaDir, 'intermediate', 'scan-result.json'), 'utf8'));

const scan = {
  ...official,
  projectName: previous.projectName,
  description: previous.description,
  languages: ['javascript', 'vue', 'css', 'html', 'json', 'markdown'],
  frameworks: ['vue', 'vite'],
  entryPoint: 'src/main.js',
  readmeHead: previous.readmeHead,
  importMap: previous.importMap,
};

fs.writeFileSync(path.join(uaDir, 'intermediate', 'scan-result.json'), JSON.stringify(scan, null, 2));

const fpInput = {
  projectRoot: root,
  filePaths: official.files.map(f => f.path),
  gitCommitHash: '',
};
fs.writeFileSync(path.join(uaDir, 'intermediate', 'fingerprint-input.json'), JSON.stringify(fpInput, null, 2));
console.log(`scan: ${official.files.length} files, filteredByIgnore=${official.filteredByIgnore}`);
