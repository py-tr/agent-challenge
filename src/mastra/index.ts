import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { weatherWorkflow } from './agents/weather-agent/weather-workflow'; // This can be deleted later
import { weatherAgent } from './agents/weather-agent/weather-agent'; // This can be deleted later
import { yourAgent } from './agents/your-agent/your-agent' // Build your agent here

export const mastra = new Mastra({
  workflows: { weatherWorkflow }, // can be deleted later
  agents: { weatherAgent, yourAgent },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  server: {
    port: 8080,
    timeout: 10000,
  },
});
