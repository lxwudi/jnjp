import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

export function sendOk<T>(res: Response, data?: T, status = 200): void {
  if (data === undefined) {
    res.status(status).json({ ok: true });
    return;
  }

  res.status(status).json({ ok: true, data });
}

export function sendError(res: Response, status: number, message: string, details: unknown = null): void {
  res.status(status).json({ ok: false, message, details });
}

export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const err = error as { message?: string; status?: number; type?: string };

  if (err.type === "entity.parse.failed") {
    sendError(res, 400, "JSON 解析失败");
    return;
  }

  if (err.type === "entity.too.large") {
    sendError(res, 400, "请求体超过 1MB 限制");
    return;
  }

  if (typeof err.status === "number" && err.message) {
    sendError(res, err.status, err.message);
    return;
  }

  console.error("[backend] unhandled error:", error);
  sendError(res, 500, "服务内部错误", err.message ?? String(error));
};
