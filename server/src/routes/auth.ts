import { Router } from "express";
import { authenticateUser, issueToken, requireAuth, toPublicUser } from "../services/auth.js";
import { asyncHandler, sendError } from "../utils/http.js";

export const authRouter = Router();

authRouter.post(
  "/login",
  asyncHandler((req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "").trim();
    const user = authenticateUser(username, password);

    if (!user) {
      sendError(res, 401, "用户名或密码错误");
      return;
    }

    const { token, expiresAt } = issueToken(user);
    res.status(200).json({
      ok: true,
      token,
      expiresAt,
      user: toPublicUser(user),
    });
  }),
);

authRouter.get("/me", requireAuth(), (req, res) => {
  res.status(200).json({ ok: true, user: req.authUser });
});
