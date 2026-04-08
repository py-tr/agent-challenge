import { createTool } from '@mastra/core/tools';
import { z } from 'zod';


// Define your tool using the `createTool` method
export const yourTool = createTool({
  id: 'tool-name',
  description: 'Use the `createTool function to create your tool',
  inputSchema: z.object({
    foo: z.string().describe('Foo name'),
  }),
  outputSchema: z.object({
    bar: z.number(),
    baz: z.string(),
  }),
  execute: async ({ context }) => {
    return await (context.foo) => "do stuff"
  },
});


