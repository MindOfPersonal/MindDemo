const { v4: uuidv4 } = require('uuid');
const Demo = require('../models/Demo');
const DemoSession = require('../models/DemoSession');
const DemoEnvironment = require('../models/DemoEnvironment');
const DemoLog = require('../models/DemoLog');
const dockerService = require('../services/dockerService');
const logger = require('../utils/logger');
const config = require('../config');

async function createSession(demoId, visitorToken) {
  try {
    const demo = await Demo.findById(demoId);
    if (!demo) {
      throw new Error('Demo not found');
    }

    const envVars = await DemoEnvironment.getEnvVarsForContainer(demo.id);
    const sessionToken = uuidv4().replace(/-/g, '').substring(0, 12);

    const containerPort = 3000 + Math.floor(Math.random() * 1000);
    
    const container = await dockerService.createContainer({
      demoId: demo.id,
      projectPath: demo.project_path,
      port: containerPort,
      startCommand: demo.start_command,
      installCommand: demo.install_command,
      buildCommand: demo.build_command,
      envVars: {
        ...envVars,
        PORT: containerPort,
        DEMO_MODE: 'true'
      },
      memoryLimit: demo.memory_limit,
      cpuLimit: demo.cpu_limit
    });

    const sessionId = await DemoSession.create({
      demo_id: demo.id,
      session_token: sessionToken,
      container_id: container.id,
      container_port: containerPort
    });

    logger.info(`Session created: ${sessionToken} for demo ${demo.slug}`);

    return {
      sessionId,
      sessionToken,
      containerId: container.id,
      containerPort,
      demo
    };
  } catch (err) {
    logger.error('Create session error:', err);
    throw err;
  }
}

async function heartbeat(req, res) {
  try {
    const { session_token } = req.body;
    
    if (!session_token) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const session = await DemoSession.findByToken(session_token);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (session.status === 'stopped') {
      return res.json({ message: 'Session ended', ended: true });
    }

    await DemoSession.updateActivity(session.id);
    
    res.json({ 
      message: 'Heartbeat received', 
      status: session.status,
      container_port: session.container_port
    });
  } catch (err) {
    logger.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function endSession(req, res) {
  try {
    const { session_token } = req.body;
    
    if (!session_token) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const session = await DemoSession.findByToken(session_token);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await DemoSession.end(session.id);
    await dockerService.removeContainer(session.container_id);
    
    logger.info(`Session ended: ${session_token}`);
    
    res.json({ message: 'Session ended' });
  } catch (err) {
    logger.error('End session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getSession(req, res) {
  try {
    const { session_token } = req.params;
    
    const session = await DemoSession.findByToken(session_token);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const demo = await Demo.findById(session.demo_id);
    
    res.json({
      session,
      demo: {
        name: demo.name,
        slug: demo.slug,
        description: demo.description,
        container_port: session.container_port
      }
    });
  } catch (err) {
    logger.error('Get session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  createSession,
  heartbeat,
  endSession,
  getSession
};
