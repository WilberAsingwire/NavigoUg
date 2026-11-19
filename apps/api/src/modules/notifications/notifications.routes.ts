import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/auth.middleware.js";
import {
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead,
  registerDeviceToken,
  unregisterDeviceToken
} from "./notifications.service.js";

const expoPushTokenPattern = /^(ExpoPushToken|ExponentPushToken)\\[[^\\]\\r\\n]+\\]$/;
const deviceTokenSchema = z.object({
  pushToken: z.string().trim().min(1).max(255).regex(expoPushTokenPattern),
  platform: z.literal("ANDROID")
}).strict();

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, async (request, response, next) => {
  try {
    response.status(200).json({ data: await listUserNotifications(request.auth!.userId) });
  } catch (error) { next(error); }
});

notificationsRouter.post("/device-token", requireAuth, async (request, response, next) => {
  const parsed = deviceTokenSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: "INVALID_DEVICE_TOKEN",
        message: "A valid Android push token is required."
      }
    });
    return;
  }

  try {
    await registerDeviceToken(request.auth!.userId, parsed.data.pushToken);
    response.status(200).json({ data: { registered: true } });
  } catch (error) { next(error); }
});

notificationsRouter.delete("/device-token", requireAuth, async (request, response, next) => {
  const parsed = deviceTokenSchema.pick({ pushToken: true }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: "INVALID_DEVICE_TOKEN",
        message: "A valid Android push token is required."
      }
    });
    return;
  }

  try {
    const result = await unregisterDeviceToken(request.auth!.userId, parsed.data.pushToken);
    response.status(200).json({ data: result });
  } catch (error) { next(error); }
});

notificationsRouter.patch("/:id/read", requireAuth, async (request, response, next) => {
  const routeId = request.params.id;
  const id = Array.isArray(routeId) ? routeId[0] : routeId;
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
