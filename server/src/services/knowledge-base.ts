import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentActionRecord, AgentKnowledgeReference, InterfaceRecord, StrategyKey } from "../types/domain.js";

interface KnowledgeDocument {
  id: string;
  title: string;
  sourceName: string;
  category: string;
  publishedAt: string;
  tags: string[];
  body: string;
  paragraphs: string[];
}

type SearchInput = {
  query?: string;
  goal?: string;
  port?: Pick<InterfaceRecord, "name" | "usage" | "connections" | "applied"> | null;
  actionKey?: StrategyKey | null;
  limit?: number;
};

const knowledgeBaseDir = new URL("../../knowledge-base", import.meta.url);
const normalizedKnowledgeBaseDir = path.normalize(fileURLToPath(knowledgeBaseDir));

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    return { meta: {}, body: raw };
  }

  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    return { meta: {}, body: raw };
  }

  const frontMatter = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trim();
  const meta = frontMatter
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, line) => {
      const separator = line.indexOf(":");
      if (separator < 0) return result;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      result[key] = value;
      return result;
    }, {});

  return { meta, body };
}

function loadKnowledgeDocuments(): KnowledgeDocument[] {
  const files = fs
    .readdirSync(normalizedKnowledgeBaseDir)
    .filter((name) => name.endsWith(".md"))
    .sort();

  return files.map((fileName) => {
    const raw = fs.readFileSync(path.join(normalizedKnowledgeBaseDir, fileName), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const paragraphs = body
      .split(/\n\s*\n/g)
      .map((item) => item.replace(/^#+\s*/g, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      id: meta.id || fileName.replace(/\.md$/i, ""),
      title: meta.title || fileName.replace(/\.md$/i, ""),
      sourceName: meta.source || "内部知识库",
      category: meta.category || "知识条目",
      publishedAt: meta.publishedAt || "2025-01-01",
      tags: String(meta.tags || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      body,
      paragraphs,
    };
  });
}

const knowledgeDocuments = loadKnowledgeDocuments();
const knownTerms = new Set(knowledgeDocuments.flatMap((doc) => doc.tags));

function collectSearchTerms(input: SearchInput): string[] {
  const combinedText = [input.query || "", input.goal || ""].join(" ");
  const terms = new Set<string>();

  for (const term of knownTerms) {
    if (combinedText.includes(term)) terms.add(term);
  }

  if (input.actionKey === "close") {
    ["关闭接口", "零连接", "夜间时窗", "低风险", "边缘接入"].forEach((term) => terms.add(term));
  } else if (input.actionKey === "reduce") {
    ["低功耗", "轻载终端", "低利用率", "模式调整"].forEach((term) => terms.add(term));
  } else if (input.actionKey === "hybrid") {
    ["模式调整", "实验室", "保留连接", "人工复核"].forEach((term) => terms.add(term));
  }

  if (input.port) {
    if (input.port.connections === 0) {
      ["零连接", "关闭接口", "夜间时窗", "自动执行"].forEach((term) => terms.add(term));
    }
    if (input.port.connections > 0 && input.port.connections <= 2) {
      ["低功耗", "轻载终端", "低利用率"].forEach((term) => terms.add(term));
    }
    if (input.port.connections >= 4) {
      ["高连接", "人工复核", "风险分级"].forEach((term) => terms.add(term));
    }
    if (input.port.usage <= 8) {
      ["低利用率", "低风险", "边缘接入"].forEach((term) => terms.add(term));
    } else if (input.port.usage <= 18) {
      ["低功耗", "模式调整"].forEach((term) => terms.add(term));
    }
    if (input.port.applied) {
      ["风险分级"].forEach((term) => terms.add(term));
    }
    if (input.port.name.includes("GE")) {
      terms.add("边缘接入");
    }
  }

  return Array.from(terms);
}

function scoreDocument(doc: KnowledgeDocument, terms: string[]): number {
  let score = 0;

  for (const term of terms) {
    if (doc.tags.some((tag) => tag.includes(term) || term.includes(tag))) score += 14;
    if (doc.title.includes(term)) score += 9;
    if (doc.body.includes(term)) score += 5;
  }

  if (terms.includes("关闭接口") && doc.category === "SOP") score += 4;
  if (terms.includes("低功耗") && doc.category === "设备手册") score += 4;
  if (terms.includes("人工复核") && doc.category === "制度") score += 4;
  if (terms.includes("风险分级") && doc.category === "风险模型") score += 4;

  return score;
}

function pickSnippet(doc: KnowledgeDocument, terms: string[]): string {
  const bestParagraph =
    doc.paragraphs
      .map((paragraph) => ({
        paragraph,
        score: terms.reduce((sum, term) => sum + (paragraph.includes(term) ? 1 : 0), 0),
      }))
      .sort((left, right) => right.score - left.score)[0]?.paragraph || doc.paragraphs[0] || doc.body;

  return bestParagraph.slice(0, 110).trim();
}

export function searchKnowledgeBase(input: SearchInput): AgentKnowledgeReference[] {
  const terms = collectSearchTerms(input);
  const limit = Math.max(1, Math.min(6, Number(input.limit) || 3));

  return knowledgeDocuments
    .map((doc) => {
      const relevanceScore = scoreDocument(doc, terms);
      return {
        docId: doc.id,
        title: doc.title,
        sourceName: doc.sourceName,
        category: doc.category,
        publishedAt: doc.publishedAt,
        snippet: pickSnippet(doc, terms),
        relevanceScore,
      };
    })
    .filter((item) => item.relevanceScore > 0)
    .sort((left, right) => right.relevanceScore - left.relevanceScore)
    .slice(0, limit);
}

export function applyKnowledgeGrounding(input: {
  action: AgentActionRecord;
  port: InterfaceRecord;
  actionKey: StrategyKey;
  goal?: string;
}): AgentActionRecord {
  const refs = searchKnowledgeBase({
    goal: input.goal,
    port: input.port,
    actionKey: input.actionKey,
    query: `${input.action.portName} ${input.action.actionLabel}`,
    limit: 3,
  });

  const knowledgeReasons = refs
    .slice(0, 2)
    .map((ref) => `RAG 命中《${ref.title}》：${ref.snippet}`);

  return {
    ...input.action,
    knowledgeRefs: refs,
    reasons: [...input.action.reasons, ...knowledgeReasons],
  };
}

export function listKnowledgeDocuments(limit = 20): AgentKnowledgeReference[] {
  return knowledgeDocuments.slice(0, Math.max(1, Math.min(limit, knowledgeDocuments.length))).map((doc) => ({
    docId: doc.id,
    title: doc.title,
    sourceName: doc.sourceName,
    category: doc.category,
    publishedAt: doc.publishedAt,
    snippet: doc.paragraphs[0] || doc.body.slice(0, 110).trim(),
    relevanceScore: 0,
  }));
}
