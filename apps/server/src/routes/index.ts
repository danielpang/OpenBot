import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../context.js';
import { apiKeyRoutes } from './api-keys.js';
import { approvalRoutes } from './approvals.js';
import { artifactRoutes } from './artifacts.js';
import { avatarRoutes } from './avatars.js';
import { botRoutes } from './bots.js';
import { capabilityRoutes } from './capabilities.js';
import { chatRoutes } from './chats.js';
import { computerRoutes } from './computer.js';
import { connectorRoutes } from './connectors.js';
import { fileRoutes } from './files.js';
import { healthRoutes } from './health.js';
import { localRoutes } from './local.js';
import { meRoutes } from './me.js';
import { memoryRoutes } from './memories.js';
import { messageRoutes } from './messages.js';
import { providerRoutes } from './providers.js';
import { resyncRoutes } from './resync.js';
import { routineRoutes } from './routines.js';
import { runRoutes } from './runs.js';
import { settingsRoutes } from './settings.js';
import { setupRoutes } from './setup.js';
import { skillRoutes } from './skills.js';
import { webhookRoutes } from './webhooks.js';
import { hookIngressRoutes } from '../hooks/ingress.js';

// One line per route file. Feature leaves add their mount here and nothing else.

export function mountRoutes(app: OpenAPIHono<AppEnv>) {
  app.route('/', healthRoutes);
  app.route('/api/v1', meRoutes);
  app.route('/api/v1', apiKeyRoutes);
  app.route('/api/v1', settingsRoutes);
  app.route('/api/v1', resyncRoutes);
  app.route('/api/v1', capabilityRoutes);
  app.route('/api/v1', botRoutes);
  app.route('/api/v1', avatarRoutes);
  app.route('/api/v1', chatRoutes);
  app.route('/api/v1', messageRoutes);
  app.route('/api/v1', fileRoutes);
  app.route('/api/v1', providerRoutes);
  app.route('/api/v1', runRoutes);
  app.route('/api/v1', memoryRoutes);
  app.route('/api/v1', approvalRoutes);
  app.route('/api/v1', connectorRoutes);
  app.route('/api/v1', artifactRoutes);
  app.route('/api/v1', computerRoutes);
  app.route('/api/v1', routineRoutes);
  app.route('/api/v1', skillRoutes);
  app.route('/api/v1', webhookRoutes);
  app.route('/api/v1', setupRoutes);
  app.route('/api/v1', localRoutes);
  app.route('/', hookIngressRoutes);
}
