const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const logger = require('../utils/logger');
const config = require('../config');

let docker;

function initDocker() {
  try {
    docker = new Docker({ socketPath: config.DOCKER_SOCKET });
    
    docker.ping().then(() => {
      logger.info('Docker connection established');
    }).catch(err => {
      logger.error('Docker connection failed:', err.message);
    });
  } catch (err) {
    logger.error('Docker initialization error:', err.message);
  }
}

function buildDockerfile(demo) {
  const commands = [
    'FROM node:20-alpine AS builder',
    `WORKDIR /app`
  ];

  if (demo.install_command) {
    const installCmd = demo.install_command.includes('npm run') 
      ? demo.install_command.replace('npm run', 'npm run')
      : demo.install_command.replace('npm ', 'npm ');
    commands.push(`RUN ${demo.install_command}`);
  } else {
    commands.push('RUN npm install');
  }

  if (demo.build_command) {
    commands.push(`RUN ${demo.build_command}`);
  }

  commands.push('FROM node:20-alpine AS runtime');
  commands.push('WORKDIR /app');
  commands.push('COPY --from=builder /app ./');
  commands.push('USER node');
  commands.push(`EXPOSE ${demo.internal_port || 3000}`);
  commands.push(`CMD [""] CMD ["${demo.start_command || 'npm start'}"]`);
  
  return commands.join('\n');
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

async function createContainer(opts) {
  if (!docker) {
    throw new Error('Docker not available');
  }

  const { demoId, projectPath, port, startCommand, installCommand, buildCommand, envVars, memoryLimit, cpuLimit, image } = opts;

  const containerName = `minddemo-demo-${demoId}-${Date.now()}`;

  const dockerfilePath = path.join(projectPath, 'Dockerfile.generated');
  const dockerfileContent = [
    'FROM node:20-alpine AS builder',
    'WORKDIR /app',
    `COPY . .`,
    installCommand ? `RUN ${installCommand}` : 'RUN npm install --production 2>/dev/null || npm install',
    buildCommand ? `RUN ${buildCommand}` : '',
    '',
    'FROM node:20-alpine AS runtime',
    'WORKDIR /app',
    'USER node',
  ].filter(l => l).join('\n');

  fs.writeFileSync(dockerfilePath, dockerfileContent);

  const img = image || 'node:20-alpine';

  const envArray = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  const containerConfig = {
    name: containerName,
    Image: img,
    Cmd: startCommand ? startCommand.split(' ') : ['npm', 'start'],
    Env: envArray,
    WorkingDir: '/app',
    HostConfig: {
      PortBindings: {
        [`${port}/tcp`]: [{ HostPort: port.toString() }]
      },
      Memory: parseMemory(memoryLimit),
      CpuPeriod: 100000,
      CpuQuota: Math.round(parseCPU(cpuLimit) * 100000),
      NetworkMode: 'bridge',
      AutoRemove: true,
      Binds: [
        `${projectPath}:/app:ro`
      ],
      Ulimits: [
        { Name: 'nproc', Hard: 65557, Soft: 1024 },
        { Name: 'nofile', Hard: 65557, Soft: 4096 }
      ],
      PidsLimit: 100,
      Privileged: false,
      ReadonlyRootfs: false
    },
    name: containerName,
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
      logger.info(`Image ${img} not found locally, pulling...`);
      await pullImage(img);
      container = await docker.createContainer(containerConfig);
    } else {
      throw err;
    }
  }

  await container.start();

  logger.info(`Container created: ${containerName}`);

  return { id: container.id, name: containerName };
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
  } catch (err) {
    logger.error(`Failed to remove container ${containerId}:`, err.message);
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

async function getContainerStats(containerId) {
  if (!docker || !containerId) return null;

  try {
    const container = docker.getContainer(containerId);
    const [stats] = await container.stats({ stream: false });
    
    return {
      cpu_usage: stats.cpu_stats?.cpu_usage?.total_usage,
      memory_usage: stats.memory_stats?.usage,
      memory_limit: stats.memory_stats?.limit,
      network_rx: stats.networks?.eth0?.rx_bytes,
      network_tx: stats.networks?.eth0?.tx_bytes
    };
  } catch (err) {
    return null;
  }
}

module.exports = {
  initDocker,
  createContainer,
  removeContainer,
  stopAllDemoContainers,
  getContainerStats
};