import type { RequestHandler } from "express";
import type { AppUser, Role, SessionUser } from "../types/domain.js";
import { createId } from "../utils/energy.js";
import { sendError } from "../utils/http.js";

const users: AppUser[] = [
  { username: "admin", password: "admin123", role: "admin", name: "系统管理员" },
  { username: "operator", password: "operator123", role: "operator", name: "运维操作员" },
  { username: "auditor", password: "auditor123", role: "auditor", name: "审计人员" },
];

const sessions = new Map<string, SessionUser>();

function cleanSessions(): void {
  const now = Date.now();
  for (const [token, value] of sessions.entries()) {
    if (value.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getAuthUserFromHeader(header: string | undefined): SessionUser | null {
  if (!header || !header.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length).trim();
  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

export function toPublicUser<T extends { username: string; role: Role; name: string }>(user: T): Omit<T, "password" | "expiresAt"> {
  return {
    username: user.username,
    role: user.role,
    name: user.name,
  } as Omit<T, "password" | "expiresAt">;
}

export function authenticateUser(username: string, password: string): AppUser | null {
  return users.find((item) => item.username === username && item.password === password) ?? null;
}

export function issueToken(user: AppUser): { token: string; expiresAt: number } {
  const token = `ec_${createId().replaceAll("-", "")}`;
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  sessions.set(token, {
    username: user.username,
    role: user.role,
    name: user.name,
    expiresAt,
  });
  return { token, expiresAt };
}

export const attachAuthUser: RequestHandler = (req, _res, next) => {
  cleanSessions();
  req.authUser = getAuthUserFromHeader(req.headers.authorization);
  next();
};

export function requireAuth(roles: Role[] = []): RequestHandler {
  return (req, res, next) => {
    const user = req.authUser;

    if (!user) {
      sendError(res, 401, "未登录或登录已过期");
      return;
    }

    if (roles.length > 0 && !roles.includes(user.role)) {
      sendError(res, 403, "权限不足");
      return;
    }

    next();
  };
}
