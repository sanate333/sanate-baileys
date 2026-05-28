#!/usr/bin/env node
/**
 * Push dual-channel changes to GitHub
 * Run: node push-dual-channel.js
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = 'sanate333/sanate-baileys';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${REPO}`;
const headers = {
  'Authorization': `token ${TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json'
};

async function pushFile(filePath, repoPath, message) {
  console.log(`\n📤 Pushing ${repoPath}...`);

  // Read local file
  const content = fs.readFileSync(filePath, 'utf-8');
  const base64 = Buffer.from(content, 'utf-8').toString('base64');

  // Get current SHA
  const getResp = await fetch(`${API}/contents/${repoPath}?ref=${BRANCH}`, { headers });
  const getData = await getResp.json();

  if (!getData.sha) {
    console.error(`❌ Could not get SHA for ${repoPath}:`, getData.message);
    return false;
  }
  console.log(`  Current SHA: ${getData.sha}`);
  console.log(`  Local size: ${content.length} bytes`);

  // Push update
  const putResp = await fetch(`${API}/contents/${repoPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message,
      content: base64,
      sha: getData.sha,
      branch: BRANCH
    })
  });

  const putData = await putResp.json();
  if (putData.content) {
    console.log(`  ✅ Pushed! New SHA: ${putData.content.sha}`);
    return true;
  } else {
    console.error(`  ❌ Push failed:`, putData.message);
    return false;
  }
}

async function main() {
  console.log('🚀 Pushing dual-channel changes to GitHub...\n');

  // Validate files exist
  const srcDir = path.join(__dirname, 'src');
  const files = [
    { local: path.join(srcDir, 'auto-reply.js'), remote: 'src/auto-reply.js', msg: 'feat: anti-ban botSend + TTS follow-up fix + setAntiBanGetter export' },
    { local: path.join(srcDir, 'routes.js'), remote: 'src/routes.js', msg: 'feat: wire anti-ban getter injection from baileys → auto-reply' },
    { local: path.join(srcDir, 'baileys.js'), remote: 'src/baileys.js', msg: 'feat: baileys-antiban integration — stealth fingerprint, warm-up, health monitor' },
    { local: path.join(__dirname, 'package.json'), remote: 'package.json', msg: 'feat: add baileys-antiban dependency' }
  ];

  for (const f of files) {
    if (!fs.existsSync(f.local)) {
      console.error(`❌ File not found: ${f.local}`);
      process.exit(1);
    }
  }

  // Validate JS syntax (skip package.json)
  console.log('🔍 Validating JavaScript syntax...');
  const jsFiles = files.filter(f => f.local.endsWith('.js'));
  for (const f of jsFiles) {
    const { execSync } = require('child_process');
    try {
      execSync(`node --check "${f.local}"`, { stdio: 'pipe' });
      console.log(`  ✅ ${path.basename(f.local)} — syntax OK`);
    } catch (e2) {
      console.error(`  ❌ ${path.basename(f.local)} — SYNTAX ERROR:`);
      console.error(e2.stderr?.toString() || e2.message);
      process.exit(1);
    }
  }
  // Validate package.json
  const pkgFiles = files.filter(f => f.local.endsWith('.json'));
  for (const f of pkgFiles) {
    try {
      JSON.parse(fs.readFileSync(f.local, 'utf-8'));
      console.log(`  ✅ ${path.basename(f.local)} — JSON OK`);
    } catch (e) {
      console.error(`  ❌ ${path.basename(f.local)} — INVALID JSON:`, e.message);
      process.exit(1);
    }
  }

  // Push all files
  let success = 0;
  for (const f of files) {
    const ok = await pushFile(f.local, f.remote, f.msg);
    if (ok) success++;
  }

  if (success === files.length) {
    console.log(`\n🎉 All ${files.length} files pushed successfully!`);
    console.log('🔄 Render will auto-deploy from main branch in ~2 minutes.');
    console.log('📡 Check: https://sanate-wa-bot.onrender.com/api/whatsapp/status');
  } else {
    console.log(`\n⚠️ ${success}/${files.length} files pushed. Check errors above.`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
