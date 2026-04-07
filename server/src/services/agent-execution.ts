import type { AgentJobRecord, AgentRunRecord } from "../types/domain.js";
import { appendAgentJobEvent, markAgentJobExecuted } from "./agent-runtime.js";
import { executeAgentRun, summarizeAgentRuns } from "./agents.js";
import { markAdviceAppliedByPortId } from "./console.js";
import { addAuditLog, addExecutionRecord, persistState, state } from "./store.js";

export function executeAndPersistAgentRun(input: {
  run: AgentRunRecord;
  approvedBy: string;
  moduleName?: string;
  actionName?: string;
  executionMessage?: string;
}): {
  run: AgentRunRecord;
  summary: ReturnType<typeof summarizeAgentRuns>;
  job: AgentJobRecord | null;
} {
  const { run, approvedBy, moduleName = "智能体", actionName = "执行策略", executionMessage } = input;

  if (run.status !== "executed") {
    const execution = executeAgentRun(run, state.interfaces, approvedBy);
    run.status = "executed";
    run.gate.approved = true;
    run.gate.approvedBy = approvedBy;
    run.execution = execution;
    run.explanation = `${run.explanation} 已由 ${approvedBy} 执行，共 ${execution.applied.length} 项。`;

    execution.applied.forEach((item) => {
      addExecutionRecord(moduleName, item.actionLabel, item.portName, item.impact);
      markAdviceAppliedByPortId(item.portId);
    });

    addAuditLog(
      moduleName,
      actionName,
      `Run ${run.id.slice(0, 8)}`,
      `执行 ${execution.applied.length} 项，节能影响 ${execution.totalImpact.toFixed(1)}`,
    );
  }

  let job: AgentJobRecord | null = null;
  if (run.jobId) {
    const resolvedExecutionMessage = executionMessage || `执行完成，共 ${run.execution?.applied.length ?? 0} 个动作已落地。`;
    appendAgentJobEvent({
      jobId: run.jobId,
      eventType: "execution",
      stage: "execution",
      agentName: "执行器",
      message: resolvedExecutionMessage,
      payload: {
        executedCount: run.execution?.applied.length ?? 0,
        totalImpact: Number((run.execution?.totalImpact ?? 0).toFixed(1)),
      },
    });
    job = markAgentJobExecuted(run.jobId, run);
  }

  persistState();
  return {
    run,
    summary: summarizeAgentRuns(state.agentRuns),
    job,
  };
}
