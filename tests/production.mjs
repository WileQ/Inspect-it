// Milestone 05 - production readiness tests.
// Deterministic, local-only checks: package metadata, CSP configuration,
// read-only analyzer audit, and a secrets/private-path scan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function exists(relative) {
  return fs.existsSync(path.join(root, relative));
}

const SOURCE_FILES = [
  'src/shared/analyzers.ts', 'src/shared/anomaly.ts', 'src/shared/archive.ts',
  'src/shared/code.ts', 'src/shared/dependencies.ts', 'src/shared/documents.ts',
  'src/shared/duplicates.ts', 'src/shared/ebook.ts', 'src/shared/email.ts',
  'src/shared/files.ts', 'src/shared/history.ts',
  'src/shared/inspection.ts', 'src/shared/media.ts', 'src/shared/ocr.ts',
  'src/shared/relationships.ts', 'src/shared/sqlite.ts', 'src/shared/web.ts',
  'src/shared/llm/analyze.ts', 'src/shared/llm/cache.ts', 'src/shared/llm/content.ts', 'src/shared/llm/context.ts',
  'src/shared/llm/payload.ts', 'src/shared/llm/provider.ts', 'src/shared/llm/transport.ts'
];

export async function runProductionTests() {
  // --- Package identity ------------------------------------------------------
  {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'semver version');
    assert.equal(pkg.productName, 'Inspect This', 'productName');
    assert.equal(pkg.license, 'MIT', 'license');
    assert.equal(pkg.build.appId, 'com.inspectthis.desktop', 'appId');
    assert.ok(pkg.build.win?.target, 'win packaging target configured');
    assert.ok(pkg.build.nsis, 'nsis installer configured');
    assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder installed');
    assert.ok(pkg.devDependencies.electron, 'electron is a devDependency');
    assert.equal(pkg.dependencies.electron, undefined, 'electron not a runtime dependency');
    for (const script of ['dev', 'build', 'test', 'package', 'dist']) {
      assert.equal(typeof pkg.scripts[script], 'string', `script ${script} present`);
    }
  }

  // --- Content Security Policy ----------------------------------------------
  {
    const vite = read('vite.config.js');
    assert.ok(vite.includes('Content-Security-Policy'), 'CSP injected by vite config');
    assert.ok(vite.includes("script-src 'self'"), 'script-src self');
    assert.ok(vite.includes('style-src'), 'style-src present');
    assert.ok(vite.includes('connect-src'), 'connect-src present (AI + website analyzer)');
    if (exists('dist/index.html')) {
      const html = read('dist/index.html');
      assert.ok(html.includes('Content-Security-Policy'), 'built index.html has CSP meta');
      assert.ok(html.includes("script-src 'self'"), 'built CSP keeps script-src self');
    }
  }

  // --- Read-only audit: analyzers must never write or execute ----------------
  {
    // NOTE: regex.exec() and sql.js db.exec() are legitimate in-memory calls;
    // the audit targets OS process execution and filesystem writes only.
    const forbidden = [
      /require\(\s*['"]node:fs['"]\s*\)/, /require\(\s*['"]fs['"]\s*\)/,
      /from ['"]node:fs['"]/, /from ['"]fs['"]/,
      /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|mkdir|mkdirSync|copyFile|copyFileSync)\b/,
      /child_process/, /\bspawn\(/, /\bexecSync\(/, /\bexecFile\(/, /\bexecFileSync\(/
    ];
    for (const file of SOURCE_FILES) {
      const text = read(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not contain ${pattern}`);
      }
    }
  }

  // --- No secrets / private paths in committed source ------------------------
  {
    const candidates = [];
    for (const relative of [
      'src', 'electron', 'scripts', 'vite.config.js', 'package.json', 'README.md', 'index.html'
    ]) {
      const full = path.join(root, relative);
      if (!fs.existsSync(full)) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        for (const file of walk(full)) {
          if (/\/(node_modules|dist|release)\//.test(file)) continue;
          if (/\.(png|ico|jpg|jpeg|gif|woff2?|ttf|exe|node|pak|bin|dat|dll)$/.test(file)) continue;
          candidates.push(path.relative(root, file));
        }
      } else {
        candidates.push(relative);
      }
    }
    const secretPatterns = [
      /sk-[A-Za-z0-9]{20,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /AKIA[0-9A-Z]{16}/,
      /(api[_-]?key|apikey|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i,
      /ghp_[A-Za-z0-9]{20,}/
    ];
    const privatePathPatterns = [
      /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+/,
      /\/home\/[a-z0-9_.-]+\//
    ];
    for (const relative of candidates) {
      let text;
      try {
        text = read(relative);
      } catch {
        continue;
      }
      for (const pattern of secretPatterns) {
        const match = text.match(pattern);
        assert.equal(match, null, `${relative} may contain a secret (${pattern})`);
      }
      for (const pattern of privatePathPatterns) {
        const match = text.match(pattern);
        assert.equal(match, null, `${relative} contains an absolute machine path (${pattern})`);
      }
    }
  }

  console.log('Milestone 05 production-readiness tests passed.');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
