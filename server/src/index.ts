import { createApp } from "./app.js";
import { startAgentAutonomyLoop } from "./services/agent-autonomy.js";

const port = Number(process.env.PORT || 8787);
const app = createApp();

app.listen(port, () => {
  startAgentAutonomyLoop();
  console.log(`[backend] listening on http://localhost:${port}`);
});
