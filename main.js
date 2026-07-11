#!/usr/bin/env node

/**
 * System Monitor - Hecaton Plugin
 *
 * Displays CPU, RAM, and GPU usage as a TUI overlay.
 *
 * Keyboard:
 *   r / R   - Refresh data
 *   q / ESC - Close (handled by host)
 *
 * Uses hecaton host APIs (synchronous globals provided by deno runner).
 */

const pluginMeta = await (async () => { try { const r = await hecaton.fs.read_file({ path: __dirname + '/plugin.json' }); return r.ok ? JSON.parse(r.content) : {}; } catch { return {}; } })();
const PLUGIN_VERSION = pluginMeta.version || '1.0.0';

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

// Color palette (ANSI palette for theme compatibility)
const colors = {
  bg: CSI + '49m',            // default background
  title: CSI + '36m',         // cyan
  label: CSI + '39m',         // default foreground
  value: CSI + '39m',         // default foreground
  dim: CSI + '2m',            // SGR dim
  green: CSI + '32m',         // green
  yellow: CSI + '33m',        // yellow
  red: CSI + '31m',           // red
  cyan: CSI + '36m',          // cyan
  orange: CSI + '33m',        // yellow
  border: CSI + '2m',         // SGR dim
  separator: CSI + '2m',      // SGR dim
};

function colorForPercent(pct) {
  if (pct <= 50) return colors.green;
  if (pct <= 80) return colors.yellow;
  return colors.red;
}

// ============================================================
// System Metrics (via hecaton host APIs - synchronous)
// ============================================================

async function detectPlatform() {
  if (typeof process !== 'undefined' && process.platform) return process.platform;

  try {
    const result = await hecaton.process.exec({
      program: 'uname',
      args: ['-s'],
      timeout_ms: 2000
    });
    const name = result?.stdout?.trim().toLowerCase();
    if (name === 'darwin') return 'darwin';
    if (name === 'linux') return 'linux';
  } catch { /* use default below */ }

  return 'win32';
}

const platform = await detectPlatform();

async function execShell(command, timeout_ms = 5000) {
  return hecaton.process.exec({
    program: '/bin/sh',
    args: ['-c', command],
    timeout_ms
  });
}

async function getCpuUsage() {
  if (platform === 'darwin') return getMacCpuUsage();
  return getWindowsCpuUsage();
}

async function getWindowsCpuUsage() {
  try {
    const result = await hecaton.process.exec({
      program: 'powershell',
      args: ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfLogicalProcessors, MaxClockSpeed, LoadPercentage | ConvertTo-Json)'
      ],
      timeout_ms: 5000
    });

    if (result && result.ok && result.stdout) {
      const info = JSON.parse(result.stdout.trim());
      const cpu = Array.isArray(info) ? info[0] : info;
      return {
        usagePercent: cpu.LoadPercentage ?? 0,
        model: (cpu.Name || 'Unknown').trim(),
        cores: cpu.NumberOfLogicalProcessors || 0,
        avgSpeedMHz: cpu.MaxClockSpeed || 0,
      };
    }
  } catch { /* fallback below */ }

  return { usagePercent: 0, model: 'Unknown', cores: 0, avgSpeedMHz: 0 };
}

async function getMacCpuUsage() {
  try {
    const result = await execShell([
      'model=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo Unknown)',
      'cores=$(sysctl -n hw.logicalcpu 2>/dev/null || echo 0)',
      'freq=$(sysctl -n hw.cpufrequency 2>/dev/null || echo 0)',
      'usage=$(top -l 1 -n 0 -s 0 2>/dev/null | awk -F"[:,%]" \'/CPU usage/ { idle=$(NF-1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", idle); print 100-idle }\')',
      'printf "%s\\n%s\\n%s\\n%s\\n" "$model" "${cores:-0}" "${freq:-0}" "${usage:-0}"'
    ].join('; '));

    if (result && result.ok && result.stdout) {
      const [model, cores, freq, usage] = result.stdout.trim().split('\n');
      return {
        usagePercent: Number(usage) || 0,
        model: (model || 'Unknown').trim(),
        cores: Number(cores) || 0,
        avgSpeedMHz: freq ? Math.round(Number(freq) / 1e6) : 0,
      };
    }
  } catch { /* fallback below */ }

  return { usagePercent: 0, model: 'Unknown', cores: 0, avgSpeedMHz: 0 };
}

async function getRamUsage() {
  if (platform === 'darwin') return getMacRamUsage();
  return getWindowsRamUsage();
}

async function getWindowsRamUsage() {
  try {
    const result = await hecaton.process.exec({
      program: 'powershell',
      args: ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json)'
      ],
      timeout_ms: 5000
    });

    if (result && result.ok && result.stdout) {
      const info = JSON.parse(result.stdout.trim());
      const totalKB = info.TotalVisibleMemorySize || 0;
      const freeKB = info.FreePhysicalMemory || 0;
      const total = totalKB * 1024;
      const free = freeKB * 1024;
      const used = total - free;
      const usagePercent = total > 0 ? (used / total) * 100 : 0;
      return { total, free, used, usagePercent };
    }
  } catch { /* fallback below */ }

  return { total: 0, free: 0, used: 0, usagePercent: 0 };
}

async function getMacRamUsage() {
  try {
    const result = await execShell([
      'total=$(sysctl -n hw.memsize 2>/dev/null || echo 0)',
      'vm=$(vm_stat 2>/dev/null)',
      'page_size=$(printf "%s\\n" "$vm" | awk \'/page size of/ { gsub(/[^0-9]/, "", $0); print $0 }\')',
      'free_pages=$(printf "%s\\n" "$vm" | awk \'/Pages free/ { gsub(/[^0-9]/, "", $0); print $0 }\')',
      'inactive_pages=$(printf "%s\\n" "$vm" | awk \'/Pages inactive/ { gsub(/[^0-9]/, "", $0); print $0 }\')',
      'spec_pages=$(printf "%s\\n" "$vm" | awk \'/Pages speculative/ { gsub(/[^0-9]/, "", $0); print $0 }\')',
      'page_size=${page_size:-4096}',
      'available_pages=$(( ${free_pages:-0} + ${inactive_pages:-0} + ${spec_pages:-0} ))',
      'free=$(( available_pages * page_size ))',
      'used=$(( total - free ))',
      'printf "%s\\n%s\\n%s\\n" "$total" "$free" "$used"'
    ].join('; '));

    if (result && result.ok && result.stdout) {
      const [totalRaw, freeRaw, usedRaw] = result.stdout.trim().split('\n');
      const total = Math.max(0, Number(totalRaw) || 0);
      const free = Math.max(0, Number(freeRaw) || 0);
      const used = Math.max(0, Number(usedRaw) || 0);
      const usagePercent = total > 0 ? (used / total) * 100 : 0;
      return { total, free, used, usagePercent };
    }
  } catch { /* fallback below */ }

  return { total: 0, free: 0, used: 0, usagePercent: 0 };
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

async function getGpuInfo(ram) {
  if (platform === 'darwin') return getMacGpuInfo();
  return getWindowsGpuInfo(ram);
}

async function getWindowsGpuInfo(ram) {
  try {
    // Task Manager gets Windows GPU utilization from the WDDM performance
    // counters.  The DirectX registry keys provide the LUID -> adapter-name
    // mapping used by those counters.  Unlike nvidia-smi, this sees Intel/AMD
    // integrated GPUs and does not wake a sleeping discrete GPU.
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$adapters = @{}
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\DirectX' -ErrorAction Stop | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.Description -and $null -ne $p.AdapterLuid) {
    $raw = [uint64]$p.AdapterLuid
    $high = [uint32]($raw -shr 32)
    $low = [uint32]($raw -band [uint64]4294967295)
    $key = ('luid_0x{0:x8}_0x{1:x8}' -f $high, $low)
    $dedicatedBytes = 0
    $sharedBytes = 0
    if ($null -ne $p.DedicatedVideoMemory) { $dedicatedBytes = [uint64]$p.DedicatedVideoMemory }
    if ($null -ne $p.SharedSystemMemory) { $sharedBytes = [uint64]$p.SharedSystemMemory }
    $adapters[$key] = [PSCustomObject]@{
      Name = [string]$p.Description
      DedicatedBytes = $dedicatedBytes
      SharedBytes = $sharedBytes
    }
  }
}

$memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)
$engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)
$adapterOrder = @{}
$nextAdapterIndex = 0
Get-CimInstance Win32_VideoController | ForEach-Object {
  if ($_.Name -notmatch 'Microsoft Basic|Remote Display|Virtual Display' -and -not $adapterOrder.ContainsKey($_.Name)) {
    $adapterOrder[$_.Name] = $nextAdapterIndex
    $nextAdapterIndex++
  }
}
$output = @()

foreach ($mem in $memory) {
  if ($mem.Name -notmatch '^(luid_0x[0-9a-f]+_0x[0-9a-f]+)_phys_[0-9]+') { continue }
  $luid = $Matches[1].ToLowerInvariant()
  $instance = $Matches[0].ToLowerInvariant()
  $adapter = $adapters[$luid]
  if ($null -eq $adapter) { continue }
  if ($adapter.Name -match 'Microsoft Basic|Remote Display|Virtual Display') { continue }

  # A GPU's headline utilization is the busiest engine.  Each engine value is
  # the sum of its per-process counters, matching Task Manager's calculation.
  $engineTotals = @{}
  foreach ($engine in $engines) {
    $engineName = $engine.Name.ToLowerInvariant()
    if ($engineName -notlike ('*_' + $instance + '_eng_*')) { continue }
    if ($engineName -match '_eng_([0-9]+)_engtype_(.*)$') {
      $engineKey = $Matches[1] + '|' + $Matches[2]
      $previous = 0.0
      if ($engineTotals.ContainsKey($engineKey)) { $previous = [double]$engineTotals[$engineKey] }
      $engineTotals[$engineKey] = $previous + [double]$engine.UtilizationPercentage
    }
  }

  $usage = 0.0
  foreach ($value in $engineTotals.Values) {
    if ([double]$value -gt $usage) { $usage = [double]$value }
  }
  $usage = [Math]::Min(100.0, [Math]::Max(0.0, $usage))

  $usesSharedMemory = ($adapter.Name -match '^Intel.*(Iris|UHD|HD)') -or ($adapter.DedicatedBytes -lt 536870912)
  if ($usesSharedMemory) {
    $usedBytes = [uint64]$mem.SharedUsage
    $totalBytes = [uint64]$adapter.SharedBytes
    $memoryType = 'Shared'
  } else {
    $usedBytes = [uint64]$mem.DedicatedUsage
    $totalBytes = [uint64]$adapter.DedicatedBytes
    $memoryType = 'VRAM'
  }

  $adapterIndex = 999
  if ($adapterOrder.ContainsKey($adapter.Name)) { $adapterIndex = [int]$adapterOrder[$adapter.Name] }

  $output += [PSCustomObject]@{
    index = $adapterIndex
    name = $adapter.Name
    usagePercent = $usage
    memUsedMB = [double]$usedBytes / 1MB
    memTotalMB = [double]$totalBytes / 1MB
    memoryType = $memoryType
    active = ($usage -ge 0.1) -or ($usedBytes -ge 16MB)
    tempC = $null
    fanPercent = $null
    powerDrawW = $null
    powerLimitW = $null
  }
}

@($output | Sort-Object index, name) | ConvertTo-Json -Compress
`;

    const result = await hecaton.process.exec({
      program: 'powershell',
      args: ['-NoProfile', '-Command', command],
      timeout_ms: 7000
    });

    if (result && result.ok && result.stdout.trim()) {
      const parsed = JSON.parse(result.stdout.trim());
      const gpus = (Array.isArray(parsed) ? parsed : [parsed]).map(gpu => ({
        index: Number.isFinite(Number(gpu.index)) ? Number(gpu.index) : null,
        name: gpu.name || 'Unknown GPU',
        usagePercent: Number(gpu.usagePercent) || 0,
        memUsedMB: Number(gpu.memUsedMB) || 0,
        // Older DirectX entries can omit shared memory capacity.  Half of
        // physical RAM is Windows' shared-GPU-memory limit in that case.
        memTotalMB: Number(gpu.memTotalMB) ||
          (gpu.memoryType === 'Shared' && ram?.total ? ram.total / 2 / 1048576 : 0),
        memoryType: gpu.memoryType || 'VRAM',
        active: Boolean(gpu.active),
        tempC: null,
        fanPercent: null,
        powerDrawW: null,
        powerLimitW: null,
      }));

      // nvidia-smi can wake an Optimus dGPU.  Only query it when Windows says
      // the NVIDIA adapter is already active, then merge its richer sensors.
      const activeNvidia = gpus.some(gpu => gpu.active && /NVIDIA/i.test(gpu.name));
      if (activeNvidia) {
        const nvidiaGpus = await getNvidiaGpuInfo();
        if (nvidiaGpus) {
          for (const gpu of gpus) {
            const details = nvidiaGpus.find(n =>
              n.name.toLowerCase() === gpu.name.toLowerCase() ||
              gpu.name.toLowerCase().includes(n.name.toLowerCase()) ||
              n.name.toLowerCase().includes(gpu.name.toLowerCase())
            );
            if (details) {
              gpu.tempC = details.tempC;
              gpu.fanPercent = details.fanPercent;
              gpu.powerDrawW = details.powerDrawW;
              gpu.powerLimitW = details.powerLimitW;
            }
          }
        }
      }

      if (gpus.length > 0) return gpus;
    }
  } catch { /* fall back to vendor tooling below */ }

  return getNvidiaGpuInfo();
}

async function getNvidiaGpuInfo() {
  try {
    const result = await hecaton.process.exec({
      program: 'nvidia-smi',
      args: [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit',
        '--format=csv,noheader,nounits',
      ],
      timeout_ms: 5000
    });

    if (result && result.ok && result.stdout) {
      const parseNum = (s) => { const n = parseFloat(s); return isNaN(n) ? null : n; };
      const gpus = [];
      for (const line of result.stdout.trim().split('\n')) {
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
    }
  } catch { /* nvidia-smi not available */ }

  return null;
}

async function getMacGpuInfo() {
  try {
    const result = await execShell(
      "system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model|Graphics\\/Displays|VRAM|Total Number of Cores/ { print }'",
      8000
    );

    if (result && result.ok && result.stdout) {
      const gpus = [];
      let current = null;
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Chipset Model:')) {
          if (current) gpus.push(current);
          current = {
            name: trimmed.replace('Chipset Model:', '').trim() || 'Apple GPU',
            usagePercent: 0,
            memUsedMB: 0,
            memTotalMB: 0,
            tempC: null,
            fanPercent: null,
            powerDrawW: null,
            powerLimitW: null,
          };
        } else if (current && trimmed.startsWith('VRAM')) {
          const mem = trimmed.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
          if (mem) {
            const value = parseFloat(mem[1]);
            current.memTotalMB = mem[2].toUpperCase() === 'GB' ? value * 1024 : value;
          }
        }
      }
      if (current) gpus.push(current);
      if (gpus.length > 0) return gpus;
    }
  } catch { /* system_profiler not available */ }

  return null;
}

async function getSystemInfo() {
  const info = { osType: 'N/A', osRelease: 'N/A', hostname: 'N/A', uptimeFormatted: 'N/A' };

  if (platform === 'darwin') return getMacSystemInfo(info);
  return getWindowsSystemInfo(info);
}

async function getWindowsSystemInfo(info) {
  try {
    const osResult = await hecaton.process.exec({
      program: 'powershell',
      args: ['-NoProfile', '-Command',
        '[PSCustomObject]@{ Caption=(Get-CimInstance Win32_OperatingSystem).Caption; Version=[System.Environment]::OSVersion.Version.ToString(); Hostname=[System.Environment]::MachineName; BootTime=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString("o") } | ConvertTo-Json'
      ],
      timeout_ms: 5000
    });

    if (osResult && osResult.ok && osResult.stdout) {
      const data = JSON.parse(osResult.stdout.trim());
      info.osType = data.Caption || 'Windows';
      info.osRelease = data.Version || '';
      info.hostname = data.Hostname || 'N/A';

      // Calculate uptime from boot time
      if (data.BootTime) {
        const bootTime = new Date(data.BootTime);
        const totalSec = Math.floor((Date.now() - bootTime.getTime()) / 1000);
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        if (days > 0) info.uptimeFormatted = `${days}d ${hours}h ${minutes}m`;
        else if (hours > 0) info.uptimeFormatted = `${hours}h ${minutes}m`;
        else info.uptimeFormatted = `${minutes}m`;
      }
    }
  } catch { /* use defaults */ }

  return info;
}

async function getMacSystemInfo(info) {
  try {
    const result = await execShell([
      'name=$(sw_vers -productName 2>/dev/null || echo macOS)',
      'version=$(sw_vers -productVersion 2>/dev/null || echo "")',
      'host=$(hostname 2>/dev/null || echo N/A)',
      'boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n \'s/.*{ sec = \\([0-9][0-9]*\\).*/\\1/p\')',
      'now=$(date +%s)',
      'uptime=$(( now - ${boot:-now} ))',
      'printf "%s\\n%s\\n%s\\n%s\\n" "$name" "$version" "$host" "$uptime"'
    ].join('; '));

    if (result && result.ok && result.stdout) {
      const [name, version, host, uptime] = result.stdout.trim().split('\n');
      info.osType = name || 'macOS';
      info.osRelease = version || '';
      info.hostname = host || 'N/A';

      const totalSec = Math.max(0, Number(uptime) || 0);
      const days = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const minutes = Math.floor((totalSec % 3600) / 60);
      if (days > 0) info.uptimeFormatted = `${days}d ${hours}h ${minutes}m`;
      else if (hours > 0) info.uptimeFormatted = `${hours}h ${minutes}m`;
      else info.uptimeFormatted = `${minutes}m`;
    }
  } catch { /* use defaults */ }

  return info;
}

// ============================================================
// Rendering
// ============================================================

let termCols = parseInt((await hecaton.env.get({ name: 'HECA_COLS' })).value || '80', 10);
let termRows = parseInt((await hecaton.env.get({ name: 'HECA_ROWS' })).value || '24', 10);
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
      const activeGpu = d.gpus.find(gpu => gpu.active) || d.gpus[0];
      line += colors.label + 'GPU: ' + ansi.reset;
      line += formatPercent(activeGpu.usagePercent) + ' ' + progressBar(activeGpu.usagePercent, 8);
    }
  }

  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, cols - plain.length);
  line += ' '.repeat(pad);

  process.stdout.write(ansi.clear + ansi.hideCursor);
  process.stdout.write(ansi.moveTo(1, 1) + line + ansi.reset);
}

function visibleLength(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function padToWidth(text, width) {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

function sectionHeader(title, width, suffix = '') {
  return [
    colors.title + ansi.bold + title + ansi.reset + suffix,
    colors.separator + '\u2500'.repeat(Math.max(1, width)) + ansi.reset,
  ];
}

function sectionBarWidth(width) {
  return Math.max(8, Math.min(25, width - 17));
}

function buildCpuSection(cpu, width) {
  const lines = sectionHeader('CPU', width);
  lines.push(
    colors.label + 'Usage ' + ansi.reset +
    progressBar(cpu.usagePercent, sectionBarWidth(width)) + '  ' + formatPercent(cpu.usagePercent)
  );
  lines.push(
    colors.label + 'Model: ' + ansi.reset +
    colors.value + truncateText(cpu.model, Math.max(8, width - 7)) + ansi.reset
  );
  lines.push(
    colors.label + 'Cores: ' + ansi.reset + colors.value + cpu.cores + ansi.reset +
    colors.dim + '  |  ' + ansi.reset + colors.label + 'Speed: ' + ansi.reset +
    colors.value + cpu.avgSpeedMHz + ' MHz' + ansi.reset
  );
  return lines;
}

function buildMemorySection(ram, width) {
  const lines = sectionHeader('Memory', width);
  lines.push(
    colors.label + 'Usage ' + ansi.reset +
    progressBar(ram.usagePercent, sectionBarWidth(width)) + '  ' + formatPercent(ram.usagePercent)
  );
  lines.push(
    colors.label + 'Used: ' + ansi.reset + colors.value + formatBytes(ram.used) + ansi.reset +
    colors.dim + ' / ' + ansi.reset + colors.value + formatBytes(ram.total) + ansi.reset
  );
  lines.push(
    colors.label + 'Free: ' + ansi.reset + colors.cyan + formatBytes(ram.free) + ansi.reset
  );
  return lines;
}

function buildGpuSection(gpu, fallbackIndex, multiple, width) {
  const gpuIndex = Number.isFinite(gpu.index) ? gpu.index : fallbackIndex;
  const title = multiple ? `GPU ${gpuIndex}` : 'GPU';
  const status = gpu.active === false ? colors.dim + ' (Inactive)' + ansi.reset : '';
  const lines = sectionHeader(title, width, status);

  lines.push(
    colors.label + 'Usage ' + ansi.reset +
    progressBar(gpu.usagePercent, sectionBarWidth(width)) + '  ' + formatPercent(gpu.usagePercent)
  );
  lines.push(
    colors.label + 'Name: ' + ansi.reset +
    colors.value + truncateText(gpu.name, Math.max(8, width - 6)) + ansi.reset
  );

  const memPct = gpu.memTotalMB > 0 ? (gpu.memUsedMB / gpu.memTotalMB) * 100 : 0;
  lines.push(
    colors.label + (gpu.memoryType || 'VRAM').padEnd(7) + ansi.reset +
    colors.value + gpu.memUsedMB.toFixed(0) + ansi.reset +
    colors.dim + ' / ' + ansi.reset + colors.value + gpu.memTotalMB.toFixed(0) + ' MB' + ansi.reset +
    colors.dim + ' (' + ansi.reset + formatPercent(memPct) + colors.dim + ')' + ansi.reset
  );

  const details = [];
  if (gpu.tempC != null) {
    details.push(
      colors.label + 'Temp: ' + ansi.reset +
      tempColor(gpu.tempC) + gpu.tempC.toFixed(0) + '\u00b0C' + ansi.reset
    );
  }
  if (gpu.fanPercent != null) {
    details.push(
      colors.label + 'Fan: ' + ansi.reset + colors.value + gpu.fanPercent.toFixed(0) + '%' + ansi.reset
    );
  }
  if (gpu.powerDrawW != null) {
    const power = gpu.powerLimitW
      ? gpu.powerDrawW.toFixed(0) + '/' + gpu.powerLimitW.toFixed(0) + 'W'
      : gpu.powerDrawW.toFixed(0) + 'W';
    details.push(colors.label + 'Power: ' + ansi.reset + colors.value + power + ansi.reset);
  }
  if (details.length > 0) lines.push(details.join(colors.dim + '  |  ' + ansi.reset));
  return lines;
}

function buildSystemSection(system, lastRefresh, width) {
  const lines = sectionHeader('System', width);
  const os = `${system.osType} ${system.osRelease}`.trim();
  lines.push(
    colors.label + 'OS: ' + ansi.reset +
    colors.value + truncateText(os, Math.max(8, width - 4)) + ansi.reset
  );
  lines.push(
    colors.label + 'Uptime: ' + ansi.reset + colors.value + system.uptimeFormatted + ansi.reset
  );
  lines.push(
    colors.label + 'Host: ' + ansi.reset +
    colors.value + truncateText(system.hostname, Math.max(8, width - 6)) + ansi.reset
  );
  if (lastRefresh) {
    const ago = Math.floor((Date.now() - lastRefresh) / 1000);
    lines.push(colors.label + 'Updated: ' + ansi.reset + colors.dim + ago + 's ago' + ansi.reset);
  }
  return lines;
}

function layoutSectionGrid(blocks, contentWidth, columnCount) {
  const gap = 2;
  const columnWidth = Math.floor((contentWidth - gap * (columnCount - 1)) / columnCount);
  const lines = [];

  for (let start = 0; start < blocks.length; start += columnCount) {
    const row = blocks.slice(start, start + columnCount);
    const rowHeight = Math.max(...row.map(block => block.length));
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
      let line = '';
      for (let column = 0; column < columnCount; column++) {
        const block = row[column];
        const text = block?.[lineIndex] || '';
        line += padToWidth(text, columnWidth);
        if (column < columnCount - 1) line += ' '.repeat(gap);
      }
      lines.push(' ' + line);
    }
    if (start + columnCount < blocks.length) lines.push('');
  }
  return lines;
}

function render(state) {
  const width = Math.max(20, Math.min(termCols, 150));
  const lines = [];
  let buttonLineIdx = -1;
  currentButtons = [];

  // Title
  lines.push('');
  lines.push(centerText(
    colors.title + ansi.bold + ' System Monitor ' + ansi.reset +
    colors.dim + 'v' + PLUGIN_VERSION + ansi.reset,
    width
  ));
  lines.push('');

  if (state.loading) {
    lines.push(centerText(colors.dim + 'Loading...' + ansi.reset, width));
  } else {
    const d = state.data;

    const contentWidth = Math.max(18, width - 2);
    const minColumnWidth = 44;
    const columnCount = Math.max(1, Math.min(3, Math.floor((contentWidth + 2) / (minColumnWidth + 2))));
    const columnWidth = Math.floor((contentWidth - 2 * (columnCount - 1)) / columnCount);
    const blocks = [
      buildCpuSection(d.cpu, columnWidth),
      buildMemorySection(d.ram, columnWidth),
    ];

    if (d.gpus && d.gpus.length > 0) {
      for (let gi = 0; gi < d.gpus.length; gi++) {
        blocks.push(buildGpuSection(d.gpus[gi], gi, d.gpus.length > 1, columnWidth));
      }
    } else {
      const noGpu = sectionHeader('GPU', columnWidth);
      noGpu.push(colors.dim + 'No GPU detected' + ansi.reset);
      blocks.push(noGpu);
    }
    blocks.push(buildSystemSection(d.system, state.lastRefresh, columnWidth));

    lines.push(...layoutSectionGrid(blocks, contentWidth, columnCount));
    lines.push('');

    // -- Keyboard --
    lines.push(' ' + colors.separator + '\u2500'.repeat(contentWidth) + ansi.reset);
    currentButtons = [{ label: '[r] Refresh', action: 'refresh' }];
    buttonLineIdx = lines.length;
    lines.push('  ' + buildHintText(currentButtons));
  }

  lines.push('');

  process.stdout.write(ansi.clear + ansi.hideCursor);
  const startRow = Math.max(1, Math.floor((termRows - lines.length) / 2));
  const startCol = Math.max(1, Math.floor((termCols - width) / 2));
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(ansi.moveTo(startRow + i, startCol) + colors.bg + lines[i] + ansi.reset);
  }

  // Record clickable areas for mouse support
  clickableAreas = [];
  if (buttonLineIdx >= 0 && currentButtons.length > 0) {
    const screenRow = startRow + buttonLineIdx;
    const plainLine = lines[buttonLineIdx].replace(/\x1b\[[0-9;]*m/g, '');
    for (const btn of currentButtons) {
      const idx = plainLine.indexOf(btn.label);
      if (idx >= 0) {
        clickableAreas.push({
          row: screenRow,
          colStart: startCol + idx,
          colEnd: startCol + idx + btn.label.length - 1,
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
// Main
// ============================================================

function main() {
  const state = {
    loading: true,
    data: null,
    startTime: Date.now(),
    lastRefresh: null,
    refreshCount: 0,
    minimized: hecaton.initialState?.minimized ?? false,
  };

  rerender();

  function rerender() {
    if (state.minimized) renderMinimized(state);
    else render(state);
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const cpu = await getCpuUsage();
      const ram = await getRamUsage();
      const gpus = await getGpuInfo(ram);
      const system = await getSystemInfo();
      state.loading = false;
      state.data = { cpu, ram, gpus, system };
      state.lastRefresh = Date.now();
      state.refreshCount++;
      rerender();
    } catch {
      rerender();
    } finally {
      refreshing = false;
    }
  }

  refresh();

  // Auto-refresh every 3 seconds
  const autoRefresh = setInterval(refresh, 3000);

  // Keyboard / RPC input
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch { /* not a TTY */ }
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  hecaton.on('window_resized', (params) => {
    termCols = params.cols || termCols;
    termRows = params.rows || termRows;
    rerender();
  });
  hecaton.on('window_minimized', () => {
    state.minimized = true;
    renderMinimized(state);
  });
  hecaton.on('window_restored', () => {
    state.minimized = false;
    render(state);
  });

  process.stdin.on('data', (key) => {
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
        hecaton.window.close();
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

try {
  main();
} catch (e) {
  process.stderr.write('Error: ' + (e.message || e) + '\n');
  process.exit(1);
}
