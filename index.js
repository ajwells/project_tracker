import { startServer } from './src/server.js';

startServer({ lan: process.argv.includes('--lan') });
