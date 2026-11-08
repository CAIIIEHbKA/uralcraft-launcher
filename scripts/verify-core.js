'use strict';

const { LauncherEngine } = require('../src/main/core/engine');

async function main() {
  const engine = new LauncherEngine();
  engine.on('log', (entry) => {
    console.log(`[${entry.level}] ${entry.message}`);
  });
  engine.on('progress', (payload) => {
    process.stdout.write(`\r${String(payload.percent).padStart(3)}%  ${payload.phaseLabel}: ${payload.detail}`.slice(0, 150).padEnd(150));
  });
  engine.on('game-state', (payload) => {
    console.log(`\nSTATE ${payload.status}${payload.message ? `: ${payload.message}` : ''}`);
  });
  console.log('URALCRAFT core verification');
  try {
    const result = await engine.verify();
    console.log('\nRESULT', result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error('\nFAILED', error);
    process.exitCode = 1;
  }
}

main();
