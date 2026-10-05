const BAR_FULL = '\u2588';
const BAR_EMPTY = '\u2591';

export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '?';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--/s';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '--';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function bar(percent, width = 20) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(width - filled);
}

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

export class ProgressRenderer {
  constructor({ slots = 4, stream = process.stdout, tty = Boolean(stream.isTTY), intervalMs = 250 } = {}) {
    this.slots = Math.max(1, slots);
    this.stream = stream;
    this.tty = tty;
    this.intervalMs = intervalMs;
    this.active = new Map();
    this.totalFiles = 0;
    this.totalBytes = 0;
    this.doneFiles = 0;
    this.failedFiles = 0;
    this.doneBytes = 0;
    this.label = '';
    this.drawn = 0;
    this.timer = null;
    this.color = tty && !process.env.NO_COLOR;
  }

  setTotals({ files, bytes, label }) {
    this.totalFiles = files ?? this.totalFiles;
    this.totalBytes = bytes ?? this.totalBytes;
    if (label != null) this.label = label;
  }

  setLabel(label) {
    this.label = label;
  }

  update(id, { name, downloaded = 0, total = 0, status } = {}) {
    const now = Date.now();
    let entry = this.active.get(id);
    if (!entry) {
      entry = { name, downloaded, total, speed: 0, lastBytes: downloaded, lastTime: now, status };
      this.active.set(id, entry);
      return;
    }
    entry.name = name ?? entry.name;
    entry.downloaded = downloaded;
    if (total) entry.total = total;
    if (status) entry.status = status;
    if (now - entry.lastTime >= 250) {
      const delta = downloaded - entry.lastBytes;
      const seconds = (now - entry.lastTime) / 1000;
      const instant = seconds > 0 ? delta / seconds : 0;
      entry.speed = entry.speed > 0 ? entry.speed * 0.6 + instant * 0.4 : instant;
      entry.lastBytes = downloaded;
      entry.lastTime = now;
    }
  }

  complete(id, sizeBytes) {
    const entry = this.active.get(id);
    this.active.delete(id);
    this.doneFiles++;
    this.doneBytes += sizeBytes ?? entry?.downloaded ?? 0;
    if (!this.tty) this.log(this.paint('green', `done  ${entry?.name ?? id} (${formatBytes(sizeBytes ?? entry?.downloaded)})`));
  }

  fail(id, message) {
    const entry = this.active.get(id);
    this.active.delete(id);
    this.failedFiles++;
    if (!this.tty) this.log(this.paint('red', `fail  ${entry?.name ?? id}: ${message}`));
  }

  start() {
    if (!this.tty || this.timer) return;
    this.timer = setInterval(() => this.render(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty) {
      this.render();
      this.stream.write('\n');
      this.drawn = 0;
    }
  }

  paint(color, text) {
    return this.color ? `${COLOR[color]}${text}${COLOR.reset}` : text;
  }

  log(line) {
    this.stream.write(`${line}\n`);
  }

  render() {
    if (!this.tty) return;
    const lines = this.buildLines();
    let output = '';
    if (this.drawn > 0) output += `\x1b[${this.drawn}A`;
    for (const line of lines) output += `\x1b[2K${line}\r\n`;
    this.stream.write(output);
    this.drawn = lines.length;
  }

  buildLines() {
    const entries = [...this.active.values()];
    const activeBytes = entries.reduce((sum, e) => sum + (e.downloaded || 0), 0);
    const activeSpeed = entries.reduce((sum, e) => sum + (e.speed || 0), 0);
    const overallDone = this.doneBytes + activeBytes;
    const overallTotal = Math.max(this.totalBytes, overallDone);
    const percent = overallTotal > 0 ? (overallDone / overallTotal) * 100 : 0;

    const header =
      `${this.label}  ${bar(percent)} ${percent.toFixed(0).padStart(3)}%  ` +
      `${formatBytes(overallDone)}/${formatBytes(overallTotal)}  ` +
      `${this.doneFiles}/${this.totalFiles} files  ` +
      `@ ${formatSpeed(activeSpeed)}` +
      (this.failedFiles > 0 ? `  ${this.failedFiles} failed` : '');

    const lines = [this.paint('cyan', header)];

    for (let i = 0; i < this.slots; i++) {
      const entry = entries[i];
      if (!entry) {
        lines.push('');
        continue;
      }
      const pct = entry.total > 0 ? Math.min(100, (entry.downloaded / entry.total) * 100) : 0;
      const eta = entry.speed > 0 && entry.total > entry.downloaded ? (entry.total - entry.downloaded) / entry.speed : null;
      const name = String(entry.name ?? '').padEnd(13).slice(0, 13);
      const body =
        `${name} ${bar(pct, 18)} ${pct.toFixed(0).padStart(3)}%  ` +
        `${formatBytes(entry.downloaded)}/${formatBytes(entry.total)}  ` +
        `${formatSpeed(entry.speed)}` +
        (eta != null ? `  eta ${formatDuration(eta)}` : '');
      lines.push(this.color ? `${COLOR.dim}${body}${COLOR.reset}` : body);
    }

    return lines;
  }
}
