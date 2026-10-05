import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fetchListing } from './listing.mjs';
import { downloadFile, runPool } from './download.mjs';
import { ProgressRenderer, formatBytes } from './progress.mjs';

const DEFAULT_URL = 'http://10.5.5.9/videos/DCIM/100GOPRO/';

const USAGE = `GoPro media downloader

Usage:
  node gopro-download.mjs [download-folder] [options]

Options:
  -o, --out <dir>    Download folder (skips the prompt)
  -u, --url <url>    Directory listing URL (default: ${DEFAULT_URL})
  -j, --jobs <n>     Simultaneous downloads (default: 4)
      --retries <n>  Attempts per file before giving up (default: 6)
      --dry-run      List files without downloading
  -h, --help         Show this help
`;

function parseArgs(argv) {
  const options = { url: process.env.GOPRO_URL || DEFAULT_URL, jobs: 4, retries: 6, dryRun: false, help: false };
  const positional = [];

  const readValue = (args, index, flag) => {
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-o':
      case '--out':
        options.out = readValue(argv, i, arg);
        i++;
        break;
      case '-u':
      case '--url':
        options.url = readValue(argv, i, arg);
        i++;
        break;
      case '-j':
      case '--jobs':
        options.jobs = Number.parseInt(readValue(argv, i, arg), 10);
        i++;
        break;
      case '--retries':
        options.retries = Number.parseInt(readValue(argv, i, arg), 10);
        i++;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length > 0 && !options.out) options.out = positional[0];
  return options;
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function promptForFolder() {
  const fallback = path.join(os.homedir(), 'Downloads', 'GoPro');
  if (!process.stdin.isTTY) return fallback;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`Download folder [${fallback}]: `, resolve));
  rl.close();
  const trimmed = answer.trim();
  return trimmed ? trimmed : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(`\n${USAGE}`);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (!Number.isInteger(options.jobs) || options.jobs < 1) {
    console.error('--jobs must be a positive integer');
    return 1;
  }

  const outDir = path.resolve(expandHome(options.out || (await promptForFolder())));
  await fsp.mkdir(outDir, { recursive: true });

  console.log(`Source:  ${options.url}`);
  console.log(`Target:  ${outDir}`);
  console.log('Fetching file list...');

  const files = await fetchListing(options.url);

  const plan = [];
  let skipped = 0;
  let skippedBytes = 0;
  for (const file of files) {
    const destPath = path.join(outDir, file.name);
    let exists = false;
    try {
      await fsp.access(destPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      skipped++;
      skippedBytes += file.size ?? 0;
    } else {
      plan.push({ ...file, destPath });
    }
  }

  const totalBytes = plan.reduce((sum, f) => sum + (f.size ?? 0), 0);
  console.log(`Found ${files.length} file(s). ${plan.length} to download (${formatBytes(totalBytes)}), ${skipped} already present.`);

  if (options.dryRun) {
    for (const file of plan) console.log(`  ${file.name}  ${file.sizeText || formatBytes(file.size)}`);
    return 0;
  }

  if (plan.length === 0) {
    console.log('Nothing to do.');
    return 0;
  }

  const renderer = new ProgressRenderer({ slots: options.jobs });
  renderer.setTotals({ files: plan.length, bytes: totalBytes, label: `GoPro -> ${path.basename(outDir) || outDir}` });
  renderer.start();

  const failures = [];
  let downloadedBytes = 0;

  await runPool(
    plan,
    async (file) => {
      const id = file.name;
      renderer.update(id, { name: file.name, downloaded: 0, total: file.size ?? 0, status: 'connecting' });
      try {
        const result = await downloadFile({
          url: file.url,
          destPath: file.destPath,
          expectedTotal: file.size,
          retries: options.retries,
          onProgress: ({ downloaded, total }) => renderer.update(id, { name: file.name, downloaded, total, status: 'downloading' }),
          onEvent: () => renderer.update(id, { name: file.name, status: 'retrying' }),
        });
        downloadedBytes += result.total ?? file.size ?? 0;
        renderer.complete(id, result.total ?? file.size);
      } catch (err) {
        renderer.fail(id, err.message);
        failures.push({ name: file.name, message: err.message });
      }
    },
    options.jobs,
  );

  renderer.stop();

  console.log(`\nDone. ${plan.length - failures.length} downloaded, ${skipped} skipped, ${failures.length} failed (${formatBytes(downloadedBytes)}).`);
  if (skippedBytes > 0) console.log(`Skipped files total ${formatBytes(skippedBytes)}.`);
  if (failures.length > 0) {
    console.log('\nFailed files (partial data kept in .part files; re-run to resume):');
    for (const failure of failures) console.log(`  ${failure.name}: ${failure.message}`);
    return 1;
  }
  return 0;
}
