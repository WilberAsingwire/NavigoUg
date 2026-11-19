import { prisma } from "../../lib/prisma.js";

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_BATCH_SIZE = 100;

type ExpoPushTicket = {
  status?: "ok" | "error";
  details?: { error?: string };
};

type PushData = {
  notificationId?: string;
  requestType?: "RIDE" | "PARCEL";
  requestId?: string;
};

type PushMessage = {
  to: string;
  sound: "default";
  title: string;
  body: string;
  priority: "high";
  channelId: "default";
  data: PushData;
};

export async function listUserNotifications(userId: string) {
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        body: true,
        requestType: true,
        requestId: true,
        readAt: true,
        createdAt: true
      }
    }),
    prisma.notification.count({ where: { userId, readAt: null } })
  ]);
  return { items, unreadCount };
}

export async function markUserNotificationRead(userId: string, notificationId: string) {
  const changed = await prisma.notification.updateMany({
    where: { id: notificationId, userId, readAt: null },
    data: { readAt: new Date() }
  });
  if (changed.count > 0) return true;

  // Idempotent for already-read items, but never reveals another user's notification.
  const existing = await prisma.notification.findFirst({
    where: { id: notificationId, userId },
    select: { id: true }
  });
  return Boolean(existing);
}

export async function markAllUserNotificationsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() }
  });
  return { updatedCount: result.count };
}

export async function registerDeviceToken(userId: string, pushToken: string) {
  return prisma.deviceToken.upsert({
    where: { pushToken },
    create: { userId, pushToken, platform: "ANDROID" },
    update: { userId, platform: "ANDROID", lastSeenAt: new Date() }
  });
}

export async function unregisterDeviceToken(userId: string, pushToken: string) {
  const result = await prisma.deviceToken.deleteMany({
    where: { userId, pushToken }
  });
  return { removed: result.count > 0 };
}

/**
 * Sends a best-effort push alert. The in-app notification row is the source of
 * truth, so Expo/network failures must never undo a ride or parcel operation.
 */
export async function sendPushNotificationToUser(
  userId: string,
  message: Omit<PushMessage, "to" | "sound" | "priority" | "channelId">
) {
  try {
    const devices = await prisma.deviceToken.findMany({
      where: { userId },
      select: { pushToken: true }
    });
    if (!devices.length) return;

    const messages: PushMessage[] = devices.map(({ pushToken }) => ({
      to: pushToken,
      sound: "default",
      title: message.title,
      body: message.body,
      priority: "high",
      channelId: "default",
      data: message.data
    }));

    for (let offset = 0; offset < messages.length; offset += EXPO_PUSH_BATCH_SIZE) {
      const batch = messages.slice(offset, offset + EXPO_PUSH_BATCH_SIZE);
      const response = await fetch(EXPO_PUSH_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000)
      });

      if (!response.ok) {
        // Do not log notification content or device tokens.
        console.warn("[notifications] Expo push service returned HTTP", response.status);
        continue;
      }

      const payload = await response.json() as { data?: ExpoPushTicket[] | ExpoPushTicket };
      const tickets = Array.isArray(payload.data)
        ? payload.data
        : payload.data
          ? [payload.data]
          : [];
      const invalidTokens = tickets.flatMap((ticket, index) =>
        ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered"
          ? [batch[index]?.to]
          : []
      ).filter((token): token is string => Boolean(token));

      if (invalidTokens.length) {
        await prisma.deviceToken.deleteMany({
          where: { pushToken: { in: invalidTokens } }
        });
      }
    }
  } catch (error) {
    // Push delivery is deliberately non-blocking for booking state changes.
    console.warn(
      "[notifications] Push delivery was unavailable:",
      error instanceof Error ? error.message : "unknown error"
    );
  }
}
