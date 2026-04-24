import cors from "cors";
import express from "express";
import { attachAuthUser } from "./services/auth.js";
import { agentRouter } from "./routes/agents.js";
import { auditRouter } from "./routes/audit.js";
import { authRouter } from "./routes/auth.js";
import { demoRouter } from "./routes/demo.js";
import { guardrailsRouter } from "./routes/guardrails.js";
import { adviceRouter, interfacesRouter, manualRouter } from "./routes/interfaces.js";
import { reportRouter, statsRouter } from "./routes/stats.js";
import { errorHandler, sendError } from "./utils/http.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(attachAuthUser);

  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "campus-switch-agent-backend",
      time: new Date().toISOString(),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/interfaces", interfacesRouter);
  app.use("/api/manual", manualRouter);
  app.use("/api/advice", adviceRouter);
  app.use("/api/guardrails", guardrailsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/reports", reportRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/agents", agentRouter);
  app.use("/api/demo", demoRouter);

  app.use("/api", (_req, res) => {
    sendError(res, 404, "接口不存在");
  });

  app.use(errorHandler);

  return app;
}
