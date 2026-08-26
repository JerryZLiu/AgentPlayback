<h1 align="center">AgentPlayback</h1>

<p align="center">
  A local visualization of your coding agents that shows you if you're running too many, or too few at a time.
</p>

<p align="center">
  <code>npx agentplayback</code>
  &nbsp;&nbsp;or&nbsp;&nbsp;
  <code>bunx agentplayback</code>
</p>

<p align="center">
  <img width="1220" height="763" alt="AgentPlayback theme transition" src="https://github.com/user-attachments/assets/ced4cec4-9668-42ad-ac6f-a8479a1fd903" />
</p>

<p align="center">
  <img width="1000" height="563" alt="AgentPlayback timeline" src="https://github.com/user-attachments/assets/e4616758-5c83-476b-8b68-fc17dd62acb6" />
</p>

<img width="1493" height="793" alt="Frame 2147230025" src="https://github.com/user-attachments/assets/983b0d61-50bd-4b91-986a-dd06c8d536cc" />

AgentPlayback reads existing Codex and Claude Code session logs and turns them into a visual timeline showing:

- When your agents are working versus waiting for your input
- Sessions grouped by task and project
- Time, token usage, and estimated cost
- Daily history across your agents

Data is processed locally and stays local.

## Supported agents

AgentPlayback currently supports **Codex** and **Claude Code**.

Contributions adding other agents are welcome. Please include screenshots verifying that the UI and data look right. The interface is intentionally opinionated, though, so integrations that require a substantially different presentation may be better maintained as forks.

## Run from source

```bash
git clone https://github.com/JerryZLiu/AgentPlayback.git
cd AgentPlayback
npm install
npm run build
npm start
```

<p align="center">
  Created by the makers of <a href="https://dayflow.so">Dayflow</a>.
</p>
