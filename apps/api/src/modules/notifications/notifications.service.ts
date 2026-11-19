import { prisma } from "../../lib/prisma.js";

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
