const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const Docker = require('dockerode');
const discordEvents = require('./discordEvents');
const logger = require('../utils/logger');
const config = require('../config');

// Probe a TCP port that is free on the host right now.
// Uses an OS-assigned ephemeral port (listen(0)) so the chosen host port
// never collides with an already-bound demo container (e.g. mindblog on 3010).
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

let docker;

async function initDocker() {
  try {
    docker = new Docker({ socketPath: config.DOCKER_SOCKET });
    await docker.ping();
    logger.info('Docker connection established');
    return true;
  } catch (err) {
    logger.error('Docker connection failed:', err.message);
    return false;
  }
}

function isAvailable() {
  return !!docker;
}

// Split a shell-like command string into an argv array without invoking a shell.
// Respects single/double quotes so `node "server.js" --port 3000` works.
function parseCommand(command) {
  const parts = String(command || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map((p) => p.replace(/^["']|["']$/g, ''));
}

function imageTagFor(demoId) {
  return `minddemo-demo-${demoId}:latest`;
}

function buildDockerfileContent(installCommand, buildCommand) {
  return [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY . .',
    installCommand
      ? `RUN ${installCommand}`
      : 'RUN npm install --no-audit --no-fund',
    buildCommand ? `RUN ${buildCommand}` : null
  ].filter(Boolean).join('\n') + '\n';
}

// Stream the project directory (excluding node_modules/.git) as a Docker build
// context. The generated Dockerfile is written into the project dir so it is
// included in the context.
function createTarStream(dir) {
  const tar = spawn('tar', [
    '-C', dir,
    '--exclude=./node_modules',
    '--exclude=./.git',
    '-cf', '-',
    '.'
  ]);
  tar.on('error', (err) => {
    logger.error('tar spawn error:', err.message);
    tar.stdout.destroy(err);
  });
  tar.stderr.on('data', (d) => logger.debug('tar:', d.toString().trim()));
  return tar.stdout;
}

async function imageExists(tag) {
  if (!docker) return false;
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch (err) {
    return false;
  }
}

async function buildImage({ demoId, projectPath, installCommand, buildCommand }) {
  if (!docker) throw new Error('Docker not available');

  const tag = imageTagFor(demoId);
  const dockerfilePath = path.join(projectPath, 'Dockerfile.generated');
  fs.writeFileSync(dockerfilePath, buildDockerfileContent(installCommand, buildCommand));

  const stream = createTarStream(projectPath);

  return new Promise((resolve, reject) => {
    // dockerode's followProgress does not always surface a failed build step as
    // the completion error; the failure arrives as an `error` event on the
    // stream. Capture it here so a failed RUN (e.g. `npm run migrate` that
    // cannot reach the database at build time) actually rejects instead of
    // silently pretending the image was built.
    let buildError = null;

    docker.buildImage(stream, { t: tag, dockerfile: 'Dockerfile.generated' }, (err, output) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        output,
        async (progressErr, result) => {
          const failure = progressErr || buildError;
          if (failure) {
            const message = failure.message || String(failure);
            logger.error(`Image build failed: ${tag}: ${message}`);
            return reject(failure instanceof Error ? failure : new Error(message));
          }
          // Belt-and-braces: even without a reported error, make sure the tag
          // really exists before callers assume the image is ready.
          if (!(await imageExists(tag))) {
            return reject(new Error(`Build finished but image ${tag} was not created`));
          }
          logger.info(`Image built: ${tag}`);
          discordEvents.imageBuilt({ id: demoId }, tag);
          resolve({ tag, result });
        },
        (event) => {
          if (event && event.stream) logger.debug(`build ${tag}: ${event.stream.trim()}`);
          if (event && event.error) {
            buildError = new Error(event.error);
            logger.error(`build ${tag}: ${event.error}`);
          }
        }
      );
    });
  });
}

// Build the image if it does not exist yet. Returns the image tag.
async function ensureImage(demo) {
  const tag = imageTagFor(demo.id);
  if (await imageExists(tag)) return tag;
  await buildImage({
    demoId: demo.id,
    projectPath: demo.project_path,
    installCommand: demo.install_command,
    buildCommand: demo.build_command
  });
  return tag;
}

// Returns a readable tar stream of a local image (used to push to an agent).
async function getImageStream(tag) {
  if (!docker) throw new Error('Docker not available');
  return docker.getImage(tag).get();
}

async function removeImage(demoId) {
  if (!docker) return;
  try {
    await docker.getImage(imageTagFor(demoId)).remove({ force: true });
    logger.info(`Image removed: ${imageTagFor(demoId)}`);
  } catch {
    // Image may not exist; ignore.
  }
}

async function createContainer(opts) {
  if (!docker) {
    throw new Error('Docker not available');
  }

  const { demoId, port, startCommand, envVars, memoryLimit, cpuLimit, image } = opts;

  const containerName = `minddemo-demo-${demoId}-${Date.now()}`;

  const img = image || imageTagFor(demoId);

  const envArray = Object.entries(envVars || {}).map(([k, v]) => `${k}=${v}`);

  const containerConfig = {
    name: containerName,
    Image: img,
    Cmd: parseCommand(startCommand || 'npm start'),
    Env: envArray,
    WorkingDir: '/app',
    HostConfig: {
      // Host networking so demos can reach host services the project assumes
      // are local (e.g. MariaDB on 127.0.0.1:3306) without rewriting DB_HOST.
      // The host port is chosen freely per session and the app binds it directly.
      NetworkMode: 'host',
      Memory: parseMemory(memoryLimit),
      CpuPeriod: 100000,
      CpuQuota: Math.round(parseCPU(cpuLimit) * 100000),
      AutoRemove: true,
      Ulimits: [
        { Name: 'nproc', Hard: 65557, Soft: 1024 },
        { Name: 'nofile', Hard: 65557, Soft: 4096 }
      ],
      PidsLimit: 100,
      Privileged: false,
      ReadonlyRootfs: false
    },
    Tty: false,
    OpenStdin: false,
    StdinOnce: false
  };

  let container;
  try {
    container = await docker.createContainer(containerConfig);
  } catch (err) {
    const message = err?.message || '';
    if (/No such image/i.test(message) || err?.statusCode === 404) {
      // Demo images are built locally (minddemo-demo-<id>); they are not in any
      // registry, so attempting to pull yields a confusing "pull access denied".
      // Fail with the real cause instead.
      if (/^minddemo-demo-/.test(img)) {
        throw new Error(`Demo image ${img} is missing; the image build did not complete successfully`);
      }
      logger.info(`Image ${img} not found locally, pulling...`);
      await pullImage(img);
      container = await docker.createContainer(containerConfig);
    } else {
      throw err;
    }
  }

  await container.start();

  logger.info(`Container created: ${containerName}`);

  discordEvents.containerCreated({ id: demoId }, { id: container.id }, port);

  return { id: container.id, name: containerName };
}

async function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (progressErr, output) => (progressErr ? reject(progressErr) : resolve(output)),
        (event) => {
          if (event && event.status && event.id) {
            logger.debug(`Image pull ${event.id}: ${event.status}`);
          }
        }
      );
    });
  });
}

function parseMemory(mem) {
  if (typeof mem === 'string') {
    const match = mem.match(/(\d+)([mg]?)/i);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === 'g') return num * 1024 * 1024 * 1024;
      if (unit === 'm') return num * 1024 * 1024;
      return num;
    }
  }
  return 512 * 1024 * 1024;
}

function parseCPU(cpu) {
  if (typeof cpu === 'string') {
    const match = cpu.match(/(\d+(?:\.\d+)?)/);
    if (match) return parseFloat(match[1]);
  }
  return 1;
}

async function removeContainer(containerId) {
  if (!docker || !containerId) return;

  try {
    const container = docker.getContainer(containerId);

    try {
      await container.stop({ t: 5 });
    } catch {
    }

    try {
      await container.remove({ force: true });
    } catch {
    }

    logger.info(`Container removed: ${containerId}`);
    discordEvents.containerRemoved(containerId);
  } catch (err) {
    logger.error(`Failed to remove container ${containerId}:`, err.message);
  }
}

// Returns true only if the container exists AND is currently running.
// Dockerode's inspect() throws for a non-existent container, which we treat as
// "not running" so callers can safely recreate a missing target instead of
// erroring. This is what makes stop→start reliably spin up a fresh container.
async function isContainerRunning(containerId) {
  if (!docker || !containerId) return false;
  try {
    const container = docker.getContainer(containerId);
    const data = await container.inspect();
    return data && data.State && data.State.Running === true;
  } catch (err) {
    return false;
  }
}

async function stopAllDemoContainers(demoId) {
  if (!docker) return;

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: {
        name: [`minddemo-demo-${demoId}`]
      }
    });

    for (const c of containers) {
      const container = docker.getContainer(c.Id);
      try {
        await container.stop({ t: 5 });
        await container.remove({ force: true });
        logger.info(`Stopped container ${c.Names?.[0]}`);
      } catch (err) {
        logger.error(`Error stopping container: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Error listing demo containers:', err.message);
  }
}

async function getContainerLogs(containerId, options = {}) {
  if (!docker || !containerId) return '';

  try {
    const container = docker.getContainer(containerId);
    const opts = {
      stdout: true,
      stderr: true,
      follow: false,
      tail: options.tail || 'all'
    };
    if (options.since) opts.since = options.since;
    if (options.timestamps) opts.timestamps = true;

    const logStream = await container.logs(opts);
    return logStream.toString('utf8');
  } catch (err) {
    if (/No such container/i.test(err.message)) {
      logger.warn(`Container ${containerId} no longer exists when fetching logs`);
      return '';
    }
    logger.error(`Failed to get container logs for ${containerId}:`, err.message);
    return '';
  }
}

async function getContainerStats(containerId) {
  if (!docker || !containerId) return null;

  try {
    const container = docker.getContainer(containerId);
    const [stats] = await container.stats({ stream: false });

    // CPU percentage is derived from the delta between the current and the
    // previous sample, normalised by the host's CPU time and online CPUs.
    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
      (stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage || 0) -
      (stats.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = stats.cpu_stats?.online_cpus ||
      (stats.cpu_stats?.cpu_usage?.percpu_usage?.length) || 1;
    let cpuPercent = 0;
    if (systemDelta > 0 && cpuDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * onlineCpus * 100;
    }

    const memUsage = stats.memory_stats?.usage || 0;
    const memLimit = stats.memory_stats?.limit || 0;
    const cache = stats.memory_stats?.stats?.cache || 0;
    const memUsed = Math.max(0, memUsage - cache);

    // With host networking Docker may not expose `networks.eth0`; sum whatever
    // interfaces are reported.
    let rx = 0;
    let tx = 0;
    for (const iface of Object.values(stats.networks || {})) {
      rx += iface.rx_bytes || 0;
      tx += iface.tx_bytes || 0;
    }

    return {
      cpu_usage: stats.cpu_stats?.cpu_usage?.total_usage,
      cpu_percent: Math.round(cpuPercent * 10) / 10,
      memory_usage: memUsed,
      memory_limit: memLimit,
      memory_percent: memLimit ? Math.round((memUsed / memLimit) * 1000) / 10 : 0,
      network_rx: rx,
      network_tx: tx
    };
  } catch (err) {
    return null;
  }
}

module.exports = {
  initDocker,
  isAvailable,
  buildImage,
  ensureImage,
  getImageStream,
  removeImage,
  createContainer,
  removeContainer,
  isContainerRunning,
  stopAllDemoContainers,
  getContainerStats,
  getContainerLogs,
  getFreePort,
  parseCommand
};
