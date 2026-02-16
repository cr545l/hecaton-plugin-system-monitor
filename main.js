#!/usr/bin/env node

/**
 * System Monitor - Hecaton Plugin
 *
 * Displays CPU, RAM, and GPU usage as a TUI overlay.
 *
 * Keyboard:
 *   r / R   - Refresh data
 *   q / ESC - Close (handled by host)
 */

const os = require('os');
const { execFileSync } = require('child_process');

// ============================================================
// ANSI Helpers
// ============================================================
const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear: CSI + '2J' + CSI + 'H',
  hideCursor: CSI + '?25l',
  showCursor: CSI + '?25h',
  reset: CSI + '0m',
  bold: CSI + '1m',
  dim: CSI + '2m',
  fg: (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg: (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  moveTo: (row, col) => `${CSI}${row};${col}H`,
};

// Color palette (teal/dark green theme)
const colors = {
  bg: ansi.bg(12, 22, 28),
  title: ansi.fg(80, 200, 180),
  label: ansi.fg(180, 180, 200),
  value: ansi.fg(255, 255, 255),
  dim: ansi.fg(90, 110, 115),
  green: ansi.fg(120, 220, 150),
  yellow: ansi.fg(230, 200, 100),
  red: ansi.fg(230, 110, 110),
  cyan: ansi.fg(100, 200, 230),
  orange: ansi.fg(230, 170, 100),
  border: ansi.fg(40, 80, 75),
  separator: ansi.fg(30, 65, 60),
};

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
}

// ============================================================
// System Metrics
// ============================================================

let prevCpuTimes = null;

function getCpuUsage() {
  const cpus = os.cpus();
  const current = { idle: 0, total: 0 };
  for (const cpu of cpus) {
    const t = cpu.times;
    current.idle += t.idle;
    current.total += t.user + t.nice + t.sys + t.idle + t.irq;
  }

  let usagePercent = 0;
  if (prevCpuTimes) {
    const idleDiff = current.idle - prevCpuTimes.idle;
    const totalDiff = current.total - prevCpuTimes.total;
    usagePercent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
  }
  prevCpuTimes = current;

  const model = cpus[0] ? cpus[0].model.trim() : 'Unknown';
  const cores = cpus.length;
  // Get per-core speeds
  const speeds = cpus.map(c => c.speed);
  const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  return { usagePercent, model, cores, avgSpeedMHz: Math.round(avgSpeed) };
}

function getRamUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usagePercent = (used / total) * 100;
  return { total, free, used, usagePercent };
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function getGpuInfo() {
  // Try nvidia-smi first
  try {
    const output = execFileSync('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });

    const parseNum = (s) => { const n = parseFloat(s); return isNaN(n) ? null : n; };
    const gpus = [];
    for (const line of output.trim().split('\n')) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 4) {
        gpus.push({
          name: parts[0],
          usagePercent: parseNum(parts[1]) ?? 0,
          memUsedMB: parseNum(parts[2]) ?? 0,
          memTotalMB: parseNum(parts[3]) ?? 0,
          tempC: parseNum(parts[4]),
          fanPercent: parseNum(parts[5]),
          powerDrawW: parseNum(parts[6]),
          powerLimitW: parseNum(parts[7]),
        });
      }
    }
    if (gpus.length > 0) return gpus;
  } catch { /* nvidia-smi not available */ }

  return null;
}

function getUptimeFormatted() {
  const totalSec = os.uptime();
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ============================================================
// Rendering
// ============================================================

let termCols = parseInt(process.env.HECA_COLS || '80', 10);
let termRows = parseInt(process.env.HECA_ROWS || '24', 10);
let clickableAreas = [];
let hoveredAreaIndex = -1;
let currentButtons = [];

function buildHintText(buttons) {
  let result = '';
  for (let i = 0; i < buttons.length; i++) {
    if (i > 0) result += '  ';
    const color = (i === hoveredAreaIndex) ? colors.value + ansi.bold : colors.dim;
    result += color + buttons[i].label + ansi.reset;
  }
  return result;
}

function centerText(text, width) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - plain.length) / 2));
  return ' '.repeat(pad) + text;
}

function progressBar(percent, width = 25) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = colorForPercent(clamped);
  return color + '\u2588'.repeat(filled) + colors.dim + '\u2591'.repeat(empty) + ansi.reset;
}

function formatPercent(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  return colorForPercent(clamped) + clamped.toFixed(1) + '%' + ansi.reset;
}

function drawBox(lines, width) {
  const top = colors.border + '\u250c' + '\u2500'.repeat(width - 2) + '\u2510' + ansi.reset;
  const bot = colors.border + '\u2514' + '\u2500'.repeat(width - 2) + '\u2518' + ansi.reset;
  const result = [top];
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - 2 - plain.length);
    result.push(
      colors.border + '\u2502' + ansi.reset + ' ' + line +
      ' '.repeat(pad > 0 ? pad - 1 : 0) +
      colors.border + '\u2502' + ansi.reset
    );
  }
  result.push(bot);
  return result;
}

function drawSeparator(width) {
  return colors.separator + '\u2500'.repeat(width - 2) + ansi.reset;
}

function tempColor(tempC) {
  if (tempC <= 50) return colors.green;
  if (tempC <= 75) return colors.yellow;
  return colors.red;
}

function renderMinimized(state) {
  const cols = termCols;
  const d = state.data;
  let line = '';

  if (d) {
    line += colors.label + 'CPU: ' + ansi.reset;
    line += formatPercent(d.cpu.usagePercent) + ' ' + progressBar(d.cpu.usagePercent, 8);

    line += colors.dim + ' | ' + ansi.reset;
    line += colors.label + 'RAM: ' + ansi.reset;
    line += formatPercent(d.ram.usagePercent) + ' ' + progressBar(d.ram.usagePercent, 8);

    if (d.gpus && d.gpus.length > 0) {
      line += colors.dim + ' | ' + ansi.reset;
      line += colors.label + 'GPU: ' + ansi.reset;
      line += formatPercent(d.gpus[0].usagePercent) + ' ' + progressBar(d.gpus[0].usagePercent, 8);
    }
  }

  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, cols - plain.length);
  line += ' '.repeat(pad);

  process.stdout.write(ansi.clear + ansi.hideCursor);
  process.stdout.write(ansi.moveTo(1, 1) + line + ansi.reset);
}

function render(state) {
  const width = Math.min(termCols, 72);
  const lines = [];
  let buttonLineIdx = -1;
  currentButtons = [];

  // Title
  lines.push('');
  lines.push(centerText(
    colors.title + ansi.bold + ' System Monitor ' + ansi.reset +
    colors.dim + 'v1.0.0' + ansi.reset,
    width
  ));
  lines.push('');

  if (state.loading) {
    lines.push(centerText(colors.dim + 'Loading...' + ansi.reset, width));
  } else {
    const d = state.data;

    // ── CPU ──
    lines.push('  ' + colors.title + ansi.bold + 'CPU' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    lines.push(
      '  ' + colors.label + 'Usage ' + ansi.reset +
      progressBar(d.cpu.usagePercent) + '  ' + formatPercent(d.cpu.usagePercent)
    );
    lines.push(
      '  ' + colors.label + 'Model: ' + ansi.reset +
      colors.value + truncateText(d.cpu.model, width - 14) + ansi.reset
    );
    lines.push(
      '  ' + colors.label + 'Cores: ' + ansi.reset +
      colors.value + d.cpu.cores + ansi.reset +
      colors.dim + '  |  ' + ansi.reset +
      colors.label + 'Speed: ' + ansi.reset +
      colors.value + d.cpu.avgSpeedMHz + ' MHz' + ansi.reset
    );
    lines.push('');

    // ── RAM ──
    lines.push('  ' + colors.title + ansi.bold + 'Memory' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    lines.push(
      '  ' + colors.label + 'Usage ' + ansi.reset +
      progressBar(d.ram.usagePercent) + '  ' + formatPercent(d.ram.usagePercent)
    );
    lines.push(
      '  ' + colors.label + 'Used:  ' + ansi.reset +
      colors.value + formatBytes(d.ram.used) + ansi.reset +
      colors.dim + ' / ' + ansi.reset +
      colors.value + formatBytes(d.ram.total) + ansi.reset +
      colors.dim + '  (Free: ' + ansi.reset +
      colors.cyan + formatBytes(d.ram.free) + ansi.reset +
      colors.dim + ')' + ansi.reset
    );
    lines.push('');

    // ── GPU ──
    if (d.gpus && d.gpus.length > 0) {
      for (let gi = 0; gi < d.gpus.length; gi++) {
        const gpu = d.gpus[gi];
        const gpuLabel = d.gpus.length > 1 ? `GPU ${gi}` : 'GPU';
        lines.push('  ' + colors.title + ansi.bold + gpuLabel + ansi.reset);
        lines.push('  ' + drawSeparator(width - 3));

        lines.push(
          '  ' + colors.label + 'Usage ' + ansi.reset +
          progressBar(gpu.usagePercent) + '  ' + formatPercent(gpu.usagePercent)
        );
        lines.push(
          '  ' + colors.label + 'Name:  ' + ansi.reset +
          colors.value + truncateText(gpu.name, width - 14) + ansi.reset
        );

        // VRAM
        const memPct = gpu.memTotalMB > 0 ? (gpu.memUsedMB / gpu.memTotalMB) * 100 : 0;
        lines.push(
          '  ' + colors.label + 'VRAM:  ' + ansi.reset +
          colors.value + gpu.memUsedMB.toFixed(0) + ansi.reset +
          colors.dim + ' / ' + ansi.reset +
          colors.value + gpu.memTotalMB.toFixed(0) + ' MB' + ansi.reset +
          colors.dim + '  (' + ansi.reset +
          formatPercent(memPct) +
          colors.dim + ')' + ansi.reset
        );

        // Temperature, Fan, Power in one line
        const details = [];
        if (gpu.tempC != null) {
          details.push(
            colors.label + 'Temp: ' + ansi.reset +
            tempColor(gpu.tempC) + gpu.tempC.toFixed(0) + '\u00b0C' + ansi.reset
          );
        }
        if (gpu.fanPercent != null) {
          details.push(
            colors.label + 'Fan: ' + ansi.reset +
            colors.value + gpu.fanPercent.toFixed(0) + '%' + ansi.reset
          );
        }
        if (gpu.powerDrawW != null) {
          const powerStr = gpu.powerLimitW
            ? gpu.powerDrawW.toFixed(0) + '/' + gpu.powerLimitW.toFixed(0) + 'W'
            : gpu.powerDrawW.toFixed(0) + 'W';
          details.push(
            colors.label + 'Power: ' + ansi.reset +
            colors.value + powerStr + ansi.reset
          );
        }
        if (details.length > 0) {
          lines.push('  ' + details.join(colors.dim + '  |  ' + ansi.reset));
        }
        lines.push('');
      }
    } else {
      lines.push('  ' + colors.title + ansi.bold + 'GPU' + ansi.reset);
      lines.push('  ' + drawSeparator(width - 3));
      lines.push('  ' + colors.dim + 'No GPU detected (nvidia-smi not found)' + ansi.reset);
      lines.push('');
    }

    // ── System ──
    lines.push('  ' + colors.title + ansi.bold + 'System' + ansi.reset);
    lines.push('  ' + drawSeparator(width - 3));
    lines.push(
      '  ' + colors.label + 'OS:     ' + ansi.reset +
      colors.value + os.type() + ' ' + os.release() + ansi.reset
    );
    lines.push(
      '  ' + colors.label + 'Uptime: ' + ansi.reset +
      colors.value + getUptimeFormatted() + ansi.reset +
      colors.dim + '  |  ' + ansi.reset +
      colors.label + 'Host: ' + ansi.reset +
      colors.value + os.hostname() + ansi.reset
    );

    if (state.lastRefresh) {
      const ago = Math.floor((Date.now() - state.lastRefresh) / 1000);
      lines.push(
        '  ' + colors.label + 'Updated: ' + ansi.reset +
        colors.dim + ago + 's ago' + ansi.reset
      );
    }

    lines.push('');

    // ── Keyboard ──
    lines.push('  ' + drawSeparator(width - 3));
    currentButtons = [{ label: '[r] Refresh', action: 'refresh' }];
    buttonLineIdx = lines.length;
    lines.push('  ' + buildHintText(currentButtons));
  }

  lines.push('');

  const boxed = drawBox(lines, width);
  process.stdout.write(ansi.clear + ansi.hideCursor);
  const startRow = Math.max(1, Math.floor((termRows - boxed.length) / 2));
  const startCol = Math.max(1, Math.floor((termCols - width) / 2));
  for (let i = 0; i < boxed.length; i++) {
    process.stdout.write(ansi.moveTo(startRow + i, startCol) + colors.bg + boxed[i] + ansi.reset);
  }

  // Record clickable areas for mouse support
  clickableAreas = [];
  if (buttonLineIdx >= 0 && currentButtons.length > 0) {
    const screenRow = startRow + buttonLineIdx + 1;
    const contentStart = startCol + 2;
    const plainLine = lines[buttonLineIdx].replace(/\x1b\[[0-9;]*m/g, '');
    for (const btn of currentButtons) {
      const idx = plainLine.indexOf(btn.label);
      if (idx >= 0) {
        clickableAreas.push({
          row: screenRow,
          colStart: contentStart + idx,
          colEnd: contentStart + idx + btn.label.length - 1,
          action: btn.action,
        });
      }
    }
  }
  if (hoveredAreaIndex >= clickableAreas.length) hoveredAreaIndex = -1;
}

function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

// ============================================================
// JSON-RPC via stderr
// ============================================================

function sendRpc(method, params = {}, id = 1) {
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
}

// ============================================================
// Main
// ============================================================

async function main() {
  const state = {
    loading: true,
    data: null,
    startTime: Date.now(),
    lastRefresh: null,
    refreshCount: 0,
    minimized: false,
  };

  // Initial CPU sample (first call is baseline)
  getCpuUsage();

  render(state);

  // Wait briefly for CPU delta to be meaningful
  await new Promise(r => setTimeout(r, 500));

  function rerender() {
    if (state.minimized) renderMinimized(state);
    else render(state);
  }

  function refresh() {
    state.loading = false;
    state.data = {
      cpu: getCpuUsage(),
      ram: getRamUsage(),
      gpus: getGpuInfo(),
    };
    state.lastRefresh = Date.now();
    state.refreshCount++;
    rerender();
  }

  refresh();

  // Auto-refresh every 3 seconds (system metrics change fast)
  const autoRefresh = setInterval(refresh, 3000);

  // Keyboard input
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch { /* not a TTY */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', (key) => {
    // Host RPC
    if (key.indexOf('__HECA_RPC__') !== -1) {
      const segments = key.split('__HECA_RPC__');
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        try {
          const json = JSON.parse(trimmed);
          if (json.method === 'resize' && json.params) {
            termCols = json.params.cols || termCols;
            termRows = json.params.rows || termRows;
            rerender();
          }
          if (json.method === 'minimize') {
            state.minimized = true;
            renderMinimized(state);
          }
          if (json.method === 'restore') {
            state.minimized = false;
            render(state);
          }
        } catch { /* ignore malformed segment */ }
      }
      return;
    }

    // Handle SGR mouse sequences
    const mouseRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let mouseMatch;
    let hadMouse = false;
    while ((mouseMatch = mouseRegex.exec(key)) !== null) {
      hadMouse = true;
      const cb = parseInt(mouseMatch[1], 10);
      const cx = parseInt(mouseMatch[2], 10);
      const cy = parseInt(mouseMatch[3], 10);
      const isRelease = mouseMatch[4] === 'm';

      if ((cb & 32) !== 0) {
        let newHover = -1;
        for (let i = 0; i < clickableAreas.length; i++) {
          const area = clickableAreas[i];
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            newHover = i;
            break;
          }
        }
        if (newHover !== hoveredAreaIndex) {
          hoveredAreaIndex = newHover;
          render(state);
        }
        continue;
      }

      if (isRelease) continue;
      if (cb === 64) { refresh(); continue; }
      if (cb === 65) continue;

      if (cb === 0) {
        for (const area of clickableAreas) {
          if (cy === area.row && cx >= area.colStart && cx <= area.colEnd) {
            if (area.action === 'refresh') refresh();
            break;
          }
        }
      }
    }
    if (hadMouse) return;

    switch (key) {
      case 'r':
      case 'R':
        refresh();
        break;
      case 'q':
      case 'Q':
        cleanup();
        sendRpc('close');
        break;
    }
  });

  function cleanup() {
    clearInterval(autoRefresh);
    process.stdout.write(ansi.showCursor + ansi.reset + ansi.clear);
  }

  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.stdin.on('end', () => { cleanup(); process.exit(0); });
}

main().catch((e) => {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
});
