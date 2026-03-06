#!/usr/bin/env node
// Run from SSH: node winrate.js
const { getWinRate } = require('./server/database.js');

function bar(wins, total) {
  if (!total) return '----------';
  const filled = Math.round((wins / total) * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function printStats(label, type) {
  const s = getWinRate(type);
  const rate = s.rate ? s.rate + '%' : '--';
  const streak = s.streak > 0
    ? (s.streakWin ? '🔥 ' : '❄️  ') + Math.abs(s.streak) + ' ' + (s.streakWin ? 'W' : 'L') + ' streak'
    : 'no streak';
  const last10 = s.last10 && s.last10.length
    ? s.last10.map(r => r ? '✅' : '❌').join(' ')
    : 'no data';

  console.log('\n─────────────────────────────────');
  console.log(' ' + label);
  console.log('─────────────────────────────────');
  console.log(' Record : ' + s.wins + 'W  ' + s.losses + 'L  (' + s.total + ' total)');
  console.log(' Win %  : ' + bar(s.wins, s.total) + '  ' + rate);
  console.log(' Streak : ' + streak);
  console.log(' Last 10: ' + last10);
}

printStats('1-HOUR PREDICTOR', 'hourly');
printStats('5-MIN PREDICTOR',  'fivemin');
console.log('\n─────────────────────────────────\n');
