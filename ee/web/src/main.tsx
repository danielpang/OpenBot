import { startWeb } from '@openbots/web/start';
import { managedWeb } from './extensions.js';
import './index.css';

// The managed web app: the core app with organizations (plan 21.5).
startWeb(managedWeb);
