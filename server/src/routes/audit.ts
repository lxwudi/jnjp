import { Router } from "express";
import { requireAuth } from "../services/auth.js";
import { listAuditLogs } from "../services/console.js";
import { addAuditLog, persistState } from "../services/store.js";
import { sendOk } from "../utils/http.js";

export const auditRouter = Router();

auditRouter.use(requireAuth());

auditRouter.get("/logs", (req, res) => {
  sendOk(
    res,
    listAuditLogs({
      limit: req.query.limit,
      module: req.query.module,
      action: req.query.action,
    }),
  );
});

auditRouter.post("/logs/seed", requireAuth(["admin"]), (_req, res) => {
  addAuditLog("智能体护栏", "阈值推荐", "GE1/0/03", "建议阈值调整为 13%");
  addAuditLog("接口库", "数据同步", "接口池", "同步 4 个接口样例");
  addAuditLog("自治智能体", "自动执行策略", "GE1/0/12", "切换为低功耗模式");
  persistState();
  res.status(200).json({ ok: true, message: "已注入示例日志" });
});
