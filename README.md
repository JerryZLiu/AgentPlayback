# AgentPlayback

A local dashboard for everything your coding agents did today.

AgentPlayback reads existing Codex and Claude Code session logs and turns them into a visual timeline showing:

- When your agents are working vs waiting for your input
- Sessions grouped by task and project
- Time, token usage, and estimated cost
- Daily history across your agents

Data is processed locally and stays local.

## Run

```bash
npx agentplayback
```

Requires Node.js 20 or newer.

## Supported agents

AgentPlayback currently supports **Codex** and **Claude Code**.

Contributions adding other agents are welcome. Please make sure to include screenshots verifying that the UI and data look right. The interface is intentionally opinionated, though, so integrations that require a substantially different presentation may be better maintained as forks.

## Run from source

```bash
git clone https://github.com/JerryZLiu/AgentPlayback.git
cd AgentPlayback
npm install
npm run build
npm start
```

Created by the makers of [Dayflow](https://dayflow.so).
