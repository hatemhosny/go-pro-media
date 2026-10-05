# GoPro media downloader

A small command-line app that lists the media on a GoPro camera over its local HTTP
server and downloads every file to a folder you choose. Built for Windows, but it runs
anywhere Node.js does.

## Why it exists

The camera's built-in page (`http://10.5.5.9/videos/DCIM/100GOPRO/`) lets you download
files one at a time. Large clips (3–4 GB) over the camera's Wi-Fi drop out often, and
browsers usually cap simultaneous downloads. This tool:

- downloads the whole folder in one go, with a configurable number of parallel transfers
  (default **4**, matching what the camera reliably serves);
- **resumes interrupted downloads** using HTTP Range requests — re-run it and it picks up
  where it left off instead of starting over;
- skips files that are already complete, so re-running is safe;
- retries failed transfers automatically with backoff.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (tested on 24). No third-party packages.
- The camera connected over Wi-Fi or USB so that `http://10.5.5.9` is reachable.

## Usage

Run it and answer the prompt for a download folder:

```
node gopro-download.mjs
```

Or pass the folder directly:

```
node gopro-download.mjs "D:\GoPro"
```

```
> node gopro-download.mjs "D:\GoPro"

Source:  http://10.5.5.9/videos/DCIM/100GOPRO/
Target:  D:\GoPro
Fetching file list...
Found 10 file(s). 10 to download (19.4 GB), 0 already present.
GoPro -> GoPro  ██████████░░░░░░░░░░  53%  10.3 GB/19.4 GB  4/10 files  @ 22.1 MB/s
GX010004.MP4  ███████░░░░░░░░░░░  38%  1.4 GB/3.7 GB  21.0 MB/s  eta 1m 50s
GX020004.MP4  ████████████░░░░░░  61%  2.3 GB/3.7 GB  23.4 MB/s  eta 1m 02s
...
```

### Options

| Option | Description | Default |
| --- | --- | --- |
| `-o, --out <dir>` | Download folder (skips the prompt) | prompt |
| `-u, --url <url>` | Directory listing URL | `http://10.5.5.9/videos/DCIM/100GOPRO/` |
| `-j, --jobs <n>` | Simultaneous downloads | `4` |
| `--retries <n>` | Attempts per file before giving up | `6` |
| `--dry-run` | List what would be downloaded, then exit | off |
| `-h, --help` | Show help | — |

You can also set the source URL with the `GOPRO_URL` environment variable.

Point `--url` at a different folder if your camera uses another path:

```
node gopro-download.mjs "D:\GoPro" --url "http://10.5.5.9/videos/DCIM/101GOPRO/"
```

### Resuming

Each in-progress download is written to `<name>.part`. When a transfer finishes, the file
is renamed to its final name. That gives two guarantees:

- A file with its final name is complete — it is always safe to skip.
- If the connection drops or you press `Ctrl+C`, the `.part` file stays. Run the same
  command again and it resumes from the exact byte it stopped at.

A failed run prints the files that did not finish and exits with code `1`; the `.part`
files are kept so the next run continues them.

## Development

```
npm test
```

Tests cover the directory-listing parser and the resumable download engine (including a
dropped-connection retry and Range resume, exercised against a local HTTP server).

## Notes

- Prefer `--jobs 4` or lower. The camera's web server has a small connection limit and is
  easy to saturate; more parallelism usually means more dropped transfers, not more speed.
- Sizes shown before a download starts come from the camera's listing (approximate). The
  exact size is taken from the server once each transfer begins.
- `LRV` files are small low-resolution proxies of each `MP4`; if you only want the full
  videos, you can delete the `*.LRV` files afterwards or skip this tool for them.
