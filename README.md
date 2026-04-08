# Nosana Builders Challenge: Agent-101

![Agent-101](./assets/NosanaBuildersChallengeAgents.jpg)

## Topic

Nosana Builders Challenge, 2nd edition
Agent-101: Build your first agent

## Description

The main goal of this `Nosana Builders Challenge` to teach participants to build and deploy agents. This first step will be in running a basic AI agent and giving it some basic functionality. Participants will add a tool, for the tool calling capabilities of the agent. These are basically some python functions, that will, for example, retrieve some data from a weather API, post a tweet via an API call, etc.

## [Mastra](https://github.com/mastra-ai/mastra)

For this challenge we will be using Mastra to build our tool.

> Mastra is an opinionated TypeScript framework that helps you build AI applications and features quickly. It gives you the set of primitives you need: workflows, agents, RAG, integrations, and evals. You can run Mastra on your local machine, or deploy to a serverless cloud.

### Required Reading

We recommend reading the following sections to get started with how to create an Agent and how to implement Tool Calling.

- <https://mastra.ai/en/docs/agents/overview>
- [Mastra Guide: Build an AI stock agent](https://mastra.ai/en/guides/guide/stock-agent)

## Get Started

To get started run the following command to start developing:
We recommend using [pnpm](https://pnpm.io/installation), but you can try npm, or bun if you prefer.

```sh
pnpm install
pnpm run dev
```

### LLM-Endpoint

Nosana will be providing an LLM-Endpoint, you are welcome to use your own, this can be changed in `.env`

## Assignment

### Challenge Overview

Welcome to the Nosana AI Agent Hackathon! Your mission is to build and deploy an AI agent on Nosana. While we provide a weather agent as an example, your creativity is the limit. Build agents that:

**Beginner Level:**

- **Joke Teller**: An agent that tells jokes based on topics
- **Random Fact Generator**: Share interesting facts about various subjects
- **Simple Calculator**: Perform basic math operations with explanations
- **Todo List Manager**: Help users track their daily tasks

**Intermediate Level:**

- **News Summarizer**: Fetch and summarize latest news articles
- **Crypto Price Checker**: Monitor cryptocurrency prices and changes
- **GitHub Stats Reporter**: Fetch repository statistics and insights

**Advanced Level:**

- **Blockchain Monitor**: Track and alert on blockchain activities
- **Trading Strategy Bot**: Automate simple trading strategies
- **Deploy Manager**: Deploy and manage applications on Nosana
- **Data Analysis Assistant**: Analyze CSV/JSON data and generate insights

Or any other innovative AI agent idea at your skill level!

### Getting Started

1. **Fork this repository** to your GitHub account
2. **Clone your fork** locally
3. **Install dependencies** with `pnpm install`
4. **Run the development server** with `pnpm run dev`
5. **Build your agent** using the Mastra framework

### How to build your Agent

Here we will describe the steps needed to build an agent.

#### Example: Weather Agent

Provided in this repo, there is the `Weather Agent`.
This is a fully working agent that allows a user to chat with an LLM, and fetches real time weather data for the provided location.

There are two main folders we need to pay attention to:

- [src/mastra/agents](./src/mastra/agents)
- [src/mastra/tools](./src/mastra/tools)

In `agents/` we define our agent using `new Agent({...})`, here define where we are serving our LLM, the instructions it should follow, and which tools (functions) it can call.

in `tools/` we define the functions needed to create the tool that the agents can call. We need to define the structure of the input and output data, where to fetch resources, and our business logic.

---

As a bonus, for the ambitious ones we have also provided the [src/mastra/workflows/](src/mastra/workflows/) folder as an example. This folder contains an example of how you can chain agents and tools to create a workflow, in this case, the user provides their location, and the agent retrieves the weather for the specified location, and suggests an itinerary.

#### Your Agent

We have provided two files for you to start your work:

- [src/mastra/agents/your-agent.ts](src/mastra/agents/your-agents.ts)
- [src/mastra/tools/your-tool.ts](src/mastra/tools/your-tool.ts)

Rename these files to represent the purpose of your agent and tools. You can use the [Weather Agent Example](#example:_weather_agent) as a guide until you are done with it, and then you can delete these files before submitting your final submission.

### Submission Requirements

#### 1. Code Development

- Fork this repository and develop your AI agent
- Your agent must include at least one custom tool (function)
- Code must be well-documented and include clear setup instructions
- Include environment variable examples in a `.env.example` file

#### 2. Docker Container

- Create a `Dockerfile` for your agent
- Build and push your container to Docker Hub or GitHub Container Registry
- Container must be publicly accessible
- Include the container URL in your submission

##### Build, Run, Publish

Note: You'll need an account on [Dockerhub](https://hub.docker.com/)

```sh

# Build and tag
docker build -t yourusername/agent-challenge:latest .

# Run the container locally
docker run -p 8080:8080 yourusername/agent-challenge:latest

# Login
docker login

# Push
docker push yourusername/agent-challenge:latest
```

#### 3. Nosana Deployment

- Deploy your Docker container on Nosana
- Your agent must successfully run on the Nosana network
- Include the Nosana job ID or deployment link

##### Nosana Job Definition

We have included a nosana job definition at <nosana_mastra.json>, that you can use to publish your agent to the Nosana network.

- Edit the file and add in your published docker image to the `image` property. `"image": "docker.io/yourusername/agent-challenge:latest"`
- Download and install the [@nosana/cli](https://github.com/nosana-ci/nosana-cli/)
- Load your wallet with some funds
  - Retrieve your address with: `nosana address`
  - Go to our [Discord](https://nosana.com/discord) and ask for some NOS and SOL to publish your job.
  - Run: `nosana job post --file nosana_mastra.json --market nvidia-3060 --timeout 30`

#### 4. Video Demo

- Record a 2-5 minute video demonstrating:
  - Your agent running on Nosana
  - Key features and functionality
  - Real-world use case demonstration
- Upload to YouTube, Loom, or similar platform

#### 5. Documentation

- Update this README with:
  - Agent description and purpose
  - Setup instructions
  - Environment variables required
  - Docker build and run commands
  - Example usage

### Submission Process

1. **Complete all requirements** listed above
2. **Create a Pull Request** to this repository with:
   - All your code changes
   - Updated README
   - Link to your Docker container
   - Link to your video demo
   - Nosana deployment proof
3. **Social Media Post**: Share your submission on X (Twitter)
   - Tag @nosana_ai
   - Include a brief description of your agent
   - Add hashtag #NosanaAgentChallenge

### Judging Criteria

Submissions will be evaluated based on:

1. **Innovation** (25%)

   - Originality of the agent concept
   - Creative use of AI capabilities

2. **Technical Implementation** (25%)

   - Code quality and organization
   - Proper use of the Mastra framework
   - Efficient tool implementation

3. **Nosana Integration** (25%)

   - Successful deployment on Nosana
   - Resource efficiency
   - Stability and performance

4. **Real-World Impact** (25%)
   - Practical use cases
   - Potential for adoption
   - Value proposition

### Resources

- [Nosana Documentation](https://docs.nosana.io)
- [Mastra Documentation](https://mastra.ai/docs)
- [Mastra Guide: Build an AI stock agent](https://mastra.ai/en/guides/guide/stock-agent)
- [Nosana CLI](https://github.com/nosana-ci/nosana-cli)
- [Docker Documentation](https://docs.docker.com)
- [Example Weather Agent](src/mastra/agents/weather-agent.ts)

### Support

- Join [Nosana Discord](https://discord.gg/nosana) for technical support
- Follow [@nosana_ai](https://x.com/nosana_ai) for updates

### Important Notes

- Ensure your agent doesn't expose sensitive data
- Test thoroughly before submission
- Keep your Docker images lightweight
- Document all dependencies clearly
- Make your code reproducible

Good luck, builders! We can't wait to see the innovative AI agents you create for the Nosana ecosystem.
