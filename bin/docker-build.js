#!/usr/bin/env node

/**
 * Build all Docker images locally (in parallel).
 *
 * Usage:
 *   npm run docker:build            # build all images in parallel
 *   npm run docker:build -- --image event-handler   # build one image
 *
 * Reads the version from package.json and tags each image as:
 *   stephengpope/thepopebot:{image}-{version}
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const REPO = 'stephengpope/thepopebot';

const IMAGES = [
  {
    name: 'pi-coding-agent-job',
    // Context is the repo root so the Dockerfile can COPY lib/gh-wrapper
    context: '.',
    dockerfile: 'templates/docker/pi-coding-agent-job/Dockerfile',
  },
  {
    name: 'claude-code-job',
    context: 'templates/docker/claude-code-job',
    dockerfile: 'templates/docker/claude-code-job/Dockerfile',
  },
  {
    name: 'claude-code-workspace',
    context: 'templates/docker/claude-code-workspace',
    dockerfile: 'templates/docker/claude-code-workspace/Dockerfile',
  },
  {
    name: 'claude-code-headless',
    context: 'templates/docker/claude-code-headless',
    dockerfile: 'templates/docker/claude-code-headless/Dockerfile',
  },
  {
    name: 'claude-code-cluster-worker',
    context: 'templates/docker/claude-code-cluster-worker',
    dockerfile: 'templates/docker/claude-code-cluster-worker/Dockerfile',
  },
  {
    name: 'event-handler',
    context: '.',
    dockerfile: 'templates/docker/event-handler/Dockerfile',
  },
];

// Parse --image flag
const filterArg = process.argv.find((_, i, a) => a[i - 1] === '--image');
const toBuild = filterArg
  ? IMAGES.filter((img) => img.name === filterArg)
  : IMAGES;

if (filterArg && toBuild.length === 0) {
  console.error(`Unknown image: ${filterArg}`);
  console.error(`Available: ${IMAGES.map((i) => i.name).join(', ')}`);
  process.exit(1);
}

console.log(`Building ${toBuild.length} image(s) in parallel — version ${VERSION}\n`);

// Pad image name for aligned output
const maxName = Math.max(...toBuild.map((i) => i.name.length));

function buildImage(img) {
  const tag = `${REPO}:${img.name}-${VERSION}`;
  const context = path.resolve(ROOT, img.context);
  const dockerfile = path.resolve(ROOT, img.dockerfile);
  const label = img.name.padEnd(maxName);

  console.log(`  ${label}  building — ${tag}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'docker',
      ['build', '-t', tag, '-f', dockerfile, context],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let output = '';
    let stepInfo = '';

    function processLine(line) {
      output += line + '\n';
      // Docker build step lines (classic builder)
      const stepMatch = line.match(/^Step (\d+\/\d+)\s*:\s*(.*)/);
      if (stepMatch) {
        stepInfo = `step ${stepMatch[1]} — ${stepMatch[2]}`;
        process.stderr.write(`  ${label}  ${stepInfo}\n`);
        return;
      }
      // BuildKit step lines
      const bkMatch = line.match(/^#\d+\s+\[.*?\]\s*(.*)/);
      if (bkMatch) {
        stepInfo = bkMatch[1].trim();
        process.stderr.write(`  ${label}  ${stepInfo}\n`);
        return;
      }
      // Download / install progress
      const dlMatch = line.match(/((?:Get|Fetching|Downloading|Installing|npm|Unpacking).*)/i);
      if (dlMatch) {
        process.stderr.write(`  ${label}  ${dlMatch[1].trim().slice(0, 80)}\n`);
      }
    }

    let stdoutBuf = '';
    proc.stdout.on('data', (d) => {
      stdoutBuf += d;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      lines.forEach(processLine);
    });

    let stderrBuf = '';
    proc.stderr.on('data', (d) => {
      stderrBuf += d;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      lines.forEach(processLine);
    });

    proc.on('close', (code) => {
      if (stdoutBuf) processLine(stdoutBuf);
      if (stderrBuf) processLine(stderrBuf);

      if (code === 0) {
        console.log(`  ${label}  done`);
        resolve(img.name);
      } else {
        console.error(`  ${label}  FAILED (exit ${code})`);
        console.error(output);
        reject(new Error(`${img.name} failed with exit code ${code}`));
      }
    });
  });
}

const results = await Promise.allSettled(toBuild.map(buildImage));

const failed = results.filter((r) => r.status === 'rejected');
const succeeded = results.filter((r) => r.status === 'fulfilled');

console.log(`\n${succeeded.length}/${toBuild.length} images built successfully.`);

if (failed.length > 0) {
  console.error(`${failed.length} failed: ${failed.map((r) => r.reason.message).join(', ')}`);
  process.exit(1);
}
