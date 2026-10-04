'use strict';
const { execFile } = require('child_process');

// Bekannte Spiel-Prozesse (klein geschrieben). Eigene lassen sich in den Einstellungen ergänzen.
const DEFAULT_GAMES = [
  'valorant-win64-shipping.exe', 'cs2.exe', 'csgo.exe', 'fortniteclient-win64-shipping.exe',
  'league of legends.exe', 'r5apex.exe', 'r5apex_dx12.exe', 'overwatch.exe', 'gta5.exe',
  'gta5_enhanced.exe', 'rocketleague.exe', 'dota2.exe', 'eldenring.exe', 'cyberpunk2077.exe',
  'rainbowsix.exe', 'rainbowsix_vulkan.exe', 'destiny2.exe', 'minecraft.windows.exe',
  'witcher3.exe', 'rdr2.exe', 'cod.exe', 'bf2042.exe', 'bfv.exe', 'tslgame.exe', 'rustclient.exe',
  'escapefromtarkov.exe', 'helldivers2.exe', 'bg3.exe', 'bg3_dx11.exe', 'hogwartslegacy.exe',
  'genshinimpact.exe', 'wow.exe', 'starfield.exe', 'deadbydaylight-win64-shipping.exe',
  'palworld-win64-shipping.exe', 'fallguys_client_game.exe', 'forzahorizon5.exe', 'eurotrucks2.exe',
];

/** Namen aller laufenden Prozesse (klein geschrieben). */
function listProcesses() {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const cmd = win ? 'tasklist' : 'ps';
    const args = win ? ['/fo', 'csv', '/nh'] : ['-A', '-o', 'comm='];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const names = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const name = win ? (/^"([^"]+)"/.exec(line) || [])[1] : line.trim().split('/').pop();
        if (name) names.add(name.toLowerCase());
      }
      resolve([...names].sort());
    });
  });
}

/** Erster laufender Prozess, der in der Spieleliste steht (oder null). */
async function detectGame(gameList) {
  const set = new Set(gameList.map((g) => g.toLowerCase()));
  const running = await listProcesses();
  return running.find((p) => set.has(p)) || null;
}

module.exports = { DEFAULT_GAMES, listProcesses, detectGame };
