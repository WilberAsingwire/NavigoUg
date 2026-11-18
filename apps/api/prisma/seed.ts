import "dotenv/config";
import * as argon2 from "argon2";
import { prisma } from "../src/lib/prisma.js";

async function main(): Promise<void> {
  const fullName = process.env.ADMIN_FULL_NAME?.trim();
  const phone = process.env.ADMIN_PHONE?.trim().replace(/[\s()-]/g, "");
  const password = process.env.ADMIN_PASSWORD;

  if (!fullName || !phone || !password || password.length < 12) {
    throw new Error(
      "Set ADMIN_FULL_NAME, ADMIN_PHONE and a unique ADMIN_PASSWORD of at least 12 characters in apps/api/.env before seeding."
    );
  }

  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    if (existing.role !== "ADMIN") {
      throw new Error("ADMIN_PHONE already belongs to a non-admin account. Choose a dedicated administrator phone number.");
    }
    console.info("The configured administrator account already exists; no changes were made.");
    return;
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      fullName,
      phone,
      passwordHash,
      role: "ADMIN",
      isActive: true
    }
  });
  console.info("Administrator account created. Keep its password private and change it if it was used temporarily.");
}

main()
  .catch((error: unknown) => {
    console.error("NAVIGO administrator seed failed:", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
