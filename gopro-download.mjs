#!/usr/bin/env node
import { main } from './src/cli.mjs';

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(`\n${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
