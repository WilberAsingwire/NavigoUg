import { Router } from "express";
import { requireAuth } from "../auth/auth.middleware.js";
import {
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead
} from "./notifications.service.js";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, async (request, response, next) => {
  try {
    response.status(200).json({ data: await listUserNotifications(request.auth!.userId) });
  } catch (error) { next(error); }
});

notificationsRouter.patch("/:id/read", requireAuth, async (request, response, next) => {
  const id = request.params.id;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    response.status(400).json({ error: { code: "INVALID_NOTIFICATION_ID", message: "This notification could not be found." } });
    return;
  }
  try {
    const found = await markUserNotificationRead(request.auth!.userId, id);
    if (!found) {
      response.status(404).json({ error: { code: "NOTIFICATION_NOT_FOUND", message: "This notification could not be found." } });
      return;
    }
    response.status(200).json({ data: { id, read: true } });
  } catch (error) { next(error); }
});

notificationsRouter.post("/read-all", requireAuth, async (request, response, next) => {
  try {
    response.status(200).json({ data: await markAllUserNotificationsRead(request.auth!.userId) });
  } catch (error) { next(error); }
});
