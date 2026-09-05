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
    assert.equal(pkg.productName, 'Inspect It', 'productName');
    assert.equal(pkg.license, 'MIT', 'license');
    assert.equal(pkg.build.appId, 'com.inspectit.desktop', 'appId');
    assert.ok(pkg.build.win?.target, 'win packaging target configured');
    assert.ok(pkg.build.nsis, 'nsis installer configured');
    assert.ok(pkg.build.mac?.target, 'mac packaging target configured');
    assert.ok(pkg.build.linux?.target, 'linux packaging target configured');
    assert.ok(pkg.build.linux.maintainer, 'linux maintainer configured (required by deb)');
    assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder installed');
    assert.ok(pkg.devDependencies.electron, 'electron is a devDependency');
    assert.equal(pkg.dependencies.electron, undefined, 'electron not a runtime dependency');
    for (const script of ['dev', 'build', 'test', 'package', 'dist', 'dist:win', 'dist:mac', 'dist:linux']) {
      assert.equal(typeof pkg.scripts[script], 'string', `script ${script} present`);
    }
    // Build commands must never implicitly publish; the release job owns publishing.
    for (const script of ['package', 'dist', 'dist:win', 'dist:mac', 'dist:linux', 'package:mac', 'package:linux']) {
      assert.ok(pkg.scripts[script].includes('--publish never'), `script ${script} uses --publish never`);
    }
    // Linux desktop entry name + sync (electron-builder window association).
    assert.equal(pkg.desktopName, 'inspect-it.desktop', 'package.json desktopName set');
    assert.equal(pkg.build.linux.syncDesktopName, true, 'linux.syncDesktopName enabled');
    const linuxTargets = String(pkg.build.linux.target).toLowerCase();
    assert.ok(linuxTargets.includes('appimage'), 'linux AppImage target configured');
    assert.ok(linuxTargets.includes('deb'), 'linux deb target configured');
    const macTargets = String(pkg.build.mac.target).toLowerCase();
    assert.ok(macTargets.includes('dmg'), 'mac dmg target configured');
  }

  // --- Cross-platform desktop shell -----------------------------------------
  {
    const main = read('electron/main.cjs');
    // Windows-only API guarded, not called unconditionally.
    assert.ok(main.includes("process.platform === 'win32'"), 'main.cjs guards Windows-only APIs');
    assert.ok(main.includes("globalShortcut.register(primaryShortcut"), 'main.cjs uses a per-platform shortcut');
    assert.ok(main.includes("'darwin'") || main.includes('"darwin"'), 'main.cjs handles macOS');
    assert.ok(main.includes('./autostart.cjs'), 'main.cjs uses the Linux autostart module');
    assert.ok(exists('electron/autostart.cjs'), 'Linux autostart module exists');
    assert.ok(exists('.github/workflows/build.yml'), 'CI workflow exists for cross-platform builds');
    assert.ok(exists('docs/RELEASING.md'), 'release documentation exists');
    assert.ok(exists('scripts/check-release-version.mjs'), 'tag/version guard script exists');
    const guard = read('scripts/check-release-version.mjs');
    assert.ok(guard.includes('package.json version') || guard.includes('pkg.version'), 'version guard compares tag to package.json');
    const workflow = read('.github/workflows/build.yml');
    assert.ok(workflow.includes('windows-latest') && workflow.includes('macos-latest') && workflow.includes('ubuntu-latest'), 'CI matrix covers Windows, macOS, and Linux');
    assert.ok(workflow.includes('npm run dist:win'), 'CI builds the Windows installer');
    assert.ok(workflow.includes('npm run dist:mac'), 'CI builds the macOS app');
    assert.ok(workflow.includes('npm run dist:linux'), 'CI builds the Linux packages');
    assert.ok(workflow.includes('refs/tags/v'), 'CI releases on version tags');
    assert.ok(workflow.includes('check-release-version.mjs'), 'CI verifies tag matches package.json');
    assert.ok(workflow.includes('softprops/action-gh-release'), 'CI publishes a GitHub Release');
    // Publish separation: GH_TOKEN only on the release job; build jobs never publish.
    assert.ok(workflow.includes('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), 'release job uses the GitHub token');
    const tokenLines = workflow.split(/\r?\n/).filter((line) => line.includes('GITHUB_TOKEN'));
    assert.equal(tokenLines.length, 1, 'only the release job holds the GitHub token');
    assert.ok(!workflow.includes('--publish always') && !workflow.includes('-p always'), 'no build command force-publishes');
    // Signing env is guarded (mapped *_VALUE envs exported only when non-empty),
    // so an absent secret cannot become an empty CSC_LINK that breaks macOS.
    assert.ok(workflow.includes('CSC_LINK_VALUE'), 'signing cert passed via guarded env');
    assert.ok(workflow.includes('CSC_KEY_PASSWORD_VALUE'), 'signing password passed via guarded env');
    assert.ok(workflow.includes('APPLE_APP_SPECIFIC_PASSWORD_VALUE') && workflow.includes('APPLE_TEAM_ID_VALUE'), 'Apple notarization credentials passed via guarded env');
    assert.ok(!workflow.includes('CSC_LINK: ${{ secrets.CSC_LINK }}'), 'CSC_LINK is not set unconditionally');
    assert.ok(workflow.includes("if [ -n \"$CSC_LINK_VALUE\" ]"), 'signing env exported only when the secret is present');
    const releasing = read('docs/RELEASING.md');
    assert.ok(releasing.includes('Developer ID Application'), 'release docs cover the Apple certificate');
    assert.ok(releasing.includes('CSC_LINK'), 'release docs cover CI signing secrets');
    assert.ok(releasing.includes('APPLE_APP_SPECIFIC_PASSWORD'), 'release docs cover notarization credentials');
  }

  // --- Package release metadata ---------------------------------------------
  {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.repository?.url, 'package.json repository.url is set (About link + release source)');
    assert.ok(pkg.homepage, 'package.json homepage is set');
    assert.equal(pkg.build.mac.hardenedRuntime, true, 'macOS hardened runtime enabled');
    assert.equal(pkg.build.mac.gatekeeperAssess, false, 'macOS gatekeeper assessment disabled (notarize handles it)');
  }

  // --- Local OCR packaging ---------------------------------------------------
  {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies['tesseract.js'], 'tesseract.js is a runtime dependency');
    assert.ok(pkg.dependencies['tesseract.js-core'], 'tesseract.js-core is a runtime dependency');
    assert.equal(typeof pkg.scripts['setup:ocr'], 'string', 'setup:ocr script exists');
    const files = JSON.stringify(pkg.build.files);
    assert.ok(files.includes('node_modules/tesseract.js'), 'packaged app ships tesseract.js');
    assert.ok(files.includes('node_modules/tesseract.js-core'), 'packaged app ships tesseract.js-core');
    assert.ok(exists('public/ocr/eng.traineddata.gz'), 'English OCR language data is vendored');
    assert.ok(exists('scripts/setup-ocr.mjs'), 'OCR asset setup script exists');
    const ocrSource = read('src/shared/ocr.ts');
    assert.ok(ocrSource.includes('langPath'), 'OCR uses a local language path');
    assert.ok(!ocrSource.includes('jsdelivr') && !ocrSource.includes('tessdata.projectnaptha'), 'OCR never fetches language data from a CDN');
    // Desktop OCR must route through the main-process bridge and the renderer
    // must never use a variable-specifier dynamic import of tesseract.js (Vite
    // cannot analyze that pattern). Literal imports are allowed.
    assert.ok(!ocrSource.includes('@vite-ignore'), 'no @vite-ignore on OCR imports');
    assert.ok(!/import\(\s*TESSERACT_MODULE/.test(ocrSource), 'no variable-specifier tesseract import');
    assert.ok(ocrSource.includes("import('tesseract.js')"), 'OCR imports use a literal, Vite-analyzable specifier');
    assert.ok(ocrSource.includes('desktopBridge()') && ocrSource.includes('inspectItDesktop'), 'desktop OCR bridge is the renderer path');
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

  // --- Linux autostart entry (pure builder) ---------------------------------
  {
    const { buildAutostartDesktopEntry, autostartDir, autostartFilePath, isEntryEnabled, AUTOSTART_FILE_NAME } = await import('../electron/autostart.cjs');
    const entry = buildAutostartDesktopEntry('/opt/Inspect It/Inspect It.AppImage');
    assert.ok(entry.includes('[Desktop Entry]'), 'desktop entry header');
    assert.ok(entry.includes('Type=Application'), 'desktop entry type');
    assert.ok(entry.includes('Exec="/opt/Inspect It/Inspect It.AppImage"'), 'exec path quoted and escaped');
    assert.ok(entry.includes('X-GNOME-Autostart-enabled=true'), 'autostart enabled marker');
    assert.equal(isEntryEnabled(entry), true, 'enabled entry detected');
    assert.equal(isEntryEnabled('[Desktop Entry]\nHidden=true\n'), false, 'disabled entry detected');
    assert.equal(AUTOSTART_FILE_NAME, 'inspect-it.desktop', 'autostart file name');
    const normalize = (value) => value.replace(/\\/g, '/');
    const dir = autostartDir({ XDG_CONFIG_HOME: '/tmp/custom' }, '/home/test');
    assert.ok(normalize(dir).endsWith('/tmp/custom/autostart'), 'XDG_CONFIG_HOME honored');
    const defaultDir = autostartDir({}, '/home/test');
    assert.ok(normalize(defaultDir).endsWith('/home/test/.config/autostart'), 'default autostart dir');
    assert.ok(autostartFilePath(defaultDir).endsWith('inspect-it.desktop'), 'autostart file path');
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
