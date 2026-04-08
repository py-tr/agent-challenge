
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { weatherAgent } from './agents/weather-agent';
import { yourAgent } from './agents/your-agent'

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, yourAgent },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
