// Checks every userscript (*.js at the repo root):
// - it parses (node --check),
// - its ==UserScript== header has @name, @namespace, @version (x.y.z) and
//   at least one @match or @include,
// - with --base <ref>: a script changed since <ref> has a higher @version
//   than it had there, so Violentmonkey picks up the update.
// Exits 1 and prints one line per problem when any check fails.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const baseIndex = process.argv.indexOf('--base');
const baseRef = baseIndex > -1 ? process.argv[baseIndex + 1] : null;

const files = readdirSync('.').filter(f => f.endsWith('.js')).sort();
const problems = [];

function parseHeader(source) {
    const m = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==/m);
    if (!m) return null;
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^\/\/\s*@(\S+)(?:\s+(.*))?$/);
        if (kv) (meta[kv[1]] ||= []).push((kv[2] || '').trim());
    }
    return meta;
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (!files.length) problems.push('no .js files found at the repo root');

for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        problems.push(`${file}: syntax error\n${String(error.stderr).trim()}`);
        continue;
    }

    const source = readFileSync(file, 'utf8');
    const meta = parseHeader(source);
    if (!meta) {
        problems.push(`${file}: no // ==UserScript== ... // ==/UserScript== header`);
        continue;
    }

    for (const key of ['name', 'namespace', 'version']) {
        if (!meta[key] || !meta[key][0]) problems.push(`${file}: missing @${key}`);
    }
    if (!meta.match && !meta.include) problems.push(`${file}: needs at least one @match or @include`);

    const version = meta.version && meta.version[0];
    if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
        problems.push(`${file}: @version "${version}" is not x.y.z`);
        continue;
    }

    if (!baseRef || !version) continue;

    let oldSource;
    try {
        oldSource = git('show', `${baseRef}:${file}`);
    } catch {
        continue; // new file
    }
    if (oldSource === source) continue;

    const oldVersion = parseHeader(oldSource)?.version?.[0];
    if (oldVersion && compareVersions(version, oldVersion) <= 0) {
        problems.push(`${file}: changed since ${baseRef} but @version is still ${version} (was ${oldVersion}); bump it`);
    }
}

if (problems.length) {
    for (const p of problems) console.error(`error: ${p}`);
    process.exit(1);
}
console.log(`ok: ${files.length} userscript(s) checked${baseRef ? ` against ${baseRef}` : ''}`);
