import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { weatherTool } from '../tools/weather-tool';
import { model } from '../config';

const name = "Weather Agent"
const instructions = `
      You are a helpful weather assistant that provides accurate weather information.

      Your primary function is to help users get weather details for specific locations. When responding:
      - Always ask for a location if none is provided
      - If the location name isn’t in English, please translate it
      - If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
      - Include relevant details like humidity, wind conditions, and precipitation
      - Keep responses concise but informative

      Use the weatherTool to fetch current weather data.
`
// const memory = new Memory({
//   storage: new LibSQLStore({
//     url: 'file:../mastra.db', // path is relative to the .mastra/output directory
//   }),
// }),


export const weatherAgent = new Agent({
  name,
  instructions,
  model,
  // memory,
  tools: { weatherTool },
});



