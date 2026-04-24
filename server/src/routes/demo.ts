import { Router } from "express";
import { requireAuth } from "../services/auth.js";
import { getAgentAutonomySnapshot } from "../services/agent-autonomy.js";
import { listAgentJobs } from "../services/agent-runtime.js";
import { summarizeAgentRuns } from "../services/agents.js";
import { summarizeNow } from "../services/console.js";
import { seedDemoScenario } from "../services/demo-data.js";
import { state } from "../services/store.js";
import { sendOk } from "../utils/http.js";

export const demoRouter = Router();

demoRouter.use(requireAuth());

demoRouter.post("/seed", requireAuth(["admin"]), (_req, res) => {
  const seeded = seedDemoScenario();

  sendOk(res, {
    seeded,
    metrics: summarizeNow(),
    agentSummary: summarizeAgentRuns(state.agentRuns),
    autonomy: getAgentAutonomySnapshot(),
    jobs: listAgentJobs(6),
  });
});
