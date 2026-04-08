import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Simple async function that conforms to input and output schema
const getInfo = async (ctx: string) => Promise.resolve({ bar: 42, baz: "baz" });

// Define your tool using the `createktool`
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
    return await getInfo(context.foo)
  },
});


